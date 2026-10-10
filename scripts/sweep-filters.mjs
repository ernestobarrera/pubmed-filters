#!/usr/bin/env node
/**
 * Pasa cada filtro del repositorio por PubMed y mira qué descarta el motor.
 *
 *   node scripts/sweep-filters.mjs
 *
 * Es `inspectResponse()` aplicado a lo que ya damos por bueno. Un filtro curado es fuente de
 * intención metodológica, no autoridad sobre la sintaxis actual de PubMed: un término puede haber
 * dejado de existir, o no haber existido nunca en el campo al que se dirige, y el motor lo descarta
 * sin dar error.
 *
 * NO forma parte de la suite ni de la CI: necesita red y depende de un servicio externo. Pero tampoco
 * depende de que alguien se acuerde: deja una LÍNEA BASE en `scripts/sweep-baseline.json` con lo que
 * se descartaba el día que se midió, y a partir de ahí **solo habla de lo que ha cambiado**. Un
 * descarte nuevo sale con código 1 aunque el repositorio no se haya tocado — porque PubMed sí cambia:
 * un encabezado se retira, un tipo de publicación se renombra, y un filtro que ayer recuperaba
 * empieza a recuperar menos sin avisar a nadie.
 *
 *   node scripts/sweep-filters.mjs                 compara contra la línea base
 *   node scripts/sweep-filters.mjs --fijar-base    reescribe la línea base con lo medido hoy
 *
 * El comprobador de coherencia del entorno avisa cuando la línea base envejece, que es lo que
 * convierte esto en vigilancia y no en un script que se ejecutó una vez. Respeta el límite de 3 peticiones por segundo
 * de NCBI; con una clave de API en NCBI_API_KEY va algo más rápido.
 *
 * Distingue dos cosas que no son iguales:
 *   - una frase de texto libre que simplemente no aparece en la literatura (aviso benigno);
 *   - un término dirigido a un campo donde no existe (no aporta nada y parece que sí).
 */

import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFilter, isNegation, inspectResponse } from './parse-filter.mjs';
import { esearch as esearchPost, TransportError } from './esearch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.env.NCBI_API_KEY ?? '';
const PAUSE = KEY ? 120 : 380;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function esearch(term) {
  const params = { retmax: '0', tool: 'pubmed-filters-sweep', ...(KEY ? { api_key: KEY } : {}) };
  for (let intento = 0; intento < 3; intento += 1) {
    await sleep(PAUSE);
    try {
      return (await esearchPost(term, { params })).esearchresult;
    } catch (e) {
      // Un 414 no se reintenta ni se esconde entre los «no evaluables»: la consulta no cabe.
      if (e instanceof TransportError) return { _error: e.message, _transporte: true };
      if (intento === 2) return { _error: String(e) };
      await sleep(2000);
    }
  }
  return { _error: 'sin respuesta' };
}

// `journals` entra desde el 2026-10-01. Faltaba, y era el bloque MAS usado: buscar-pubmed.html pide
// 120 filtros y 72 son de revistas, asi que la barrida cubria 49 de 120 mientras se llamaba a si
// misma completa. Un filtro de revistas es justo donde mas se muere un termino solo: una revista se
// renombra, deja de indexarse, y su [ta] desaparece sin que nadie toque el fichero.
const files = ['methodology', 'clinical', 'scope', 'candidates', 'journals'].flatMap((d) => {
  const dir = join(ROOT, 'filters', d);
  return existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => `filters/${d}/${f}`)
    : [];
});

console.log(`Barriendo ${files.length} filtros contra PubMed${KEY ? ' (con clave de API)' : ''}...\n`);

let limpios = 0;
const sucios = [];
const noEvaluables = [];
const falloTransporte = [];

for (const f of files) {
  const q = parseFilter(readFileSync(join(ROOT, f), 'utf8'));
  // Una cláusula de exclusión aislada no es ejecutable: se ancla a un tema neutro para poder verla.
  const term = isNegation(q) ? `(humans[mh]) ${q}` : q;
  const r = await esearch(term);
  if (r._transporte) { falloTransporte.push([f, r._error]); continue; }
  if (r._error) { noEvaluables.push([f, r._error]); continue; }
  // Con la consulta enviada: lo que PubMed descarta sin avisar (etiquetas ignoradas, asteriscos
  // tipográficos) no sale en `dropped`, y sin ella esta barrida lo llamaba limpio (Codex, 2026-10-08).
  const juicio = inspectResponse(r, { sentQuery: term });
  const descartes = [...juicio.dropped, ...juicio.unknownTags, ...juicio.lookalikes];
  if (descartes.length > 0) sucios.push([f, Number(r.count), descartes]);
  else limpios += 1;
}

console.log(`limpios: ${limpios}   con términos descartados: ${sucios.length}   `
  + `fallos de transporte: ${falloTransporte.length}   no evaluables: ${noEvaluables.length}\n`);
for (const [f, n, dropped] of sucios) {
  console.log(`${f}   count=${n.toLocaleString('es-ES')}`);
  for (const t of dropped) console.log(`    descartado: ${t}`);
}
for (const [f, e] of noEvaluables) console.log(`${f}   NO EVALUABLE: ${e}`);
for (const [f, e] of falloTransporte) console.log(`${f}   ${e}`);

// ---------------------------------------------------------------------------------------------
// Línea base: lo que importa no es que haya descartes, es que aparezcan descartes NUEVOS.
// ---------------------------------------------------------------------------------------------
const BASE = join(ROOT, 'scripts', 'sweep-baseline.json');
const medido = Object.fromEntries(sucios.map(([f, , dropped]) => [f, [...dropped].sort()]));

if (process.argv.includes('--fijar-base')) {
  writeFileSync(BASE, `${JSON.stringify({
    medido_el: new Date().toISOString().slice(0, 10),
    filtros_barridos: limpios + sucios.length,
    descartes_aceptados: medido,
  }, null, 2)}\n`);
  console.log(`\nlínea base fijada: ${Object.keys(medido).length} filtro(s) con descartes aceptados.`);
  process.exit(0);
}

let base = null;
try { base = JSON.parse(readFileSync(BASE, 'utf8')); } catch { /* sin línea base todavía */ }
if (!base) {
  console.log('\nNo hay línea base. Tría lo de arriba y fíjala con: node scripts/sweep-filters.mjs --fijar-base');
  process.exit(falloTransporte.length > 0 || noEvaluables.length > 0 ? 2 : 0);
}

const aceptados = base.descartes_aceptados ?? {};
const nuevos = [];
const resueltos = [];
for (const [f, terms] of Object.entries(medido)) {
  const ya = new Set(aceptados[f] ?? []);
  for (const t of terms) if (!ya.has(t)) nuevos.push(`${f}: ${t}`);
}
for (const [f, terms] of Object.entries(aceptados)) {
  const hoy = new Set(medido[f] ?? []);
  for (const t of terms) if (!hoy.has(t)) resueltos.push(`${f}: ${t}`);
}

const dias = Math.floor((Date.now() - Date.parse(base.medido_el)) / 86400000);
console.log(`línea base del ${base.medido_el} (${dias} día(s)).`);
if (resueltos.length) {
  console.log(`\nYa no se descartan (${resueltos.length}) — fija la base para dejarlo escrito:`);
  for (const r of resueltos) console.log(`  + ${r}`);
}
if (nuevos.length) {
  console.log(`\nDESCARTES NUEVOS (${nuevos.length}), que no estaban el ${base.medido_el}:`);
  for (const n of nuevos) console.log(`  ! ${n}`);
  console.log('\nTría cada caso antes de tocar nada:');
  console.log('  frase de texto libre que no existe en la literatura -> aviso benigno;');
  console.log('  termino dirigido a un campo donde no existe -> esta muerto, mide que aporta');
  console.log('  arreglarlo antes de editar un filtro publicado y referenciado.');
  console.log('  Y comprueba si la forma sin comillas vive: medido el 2026-10-01, cinco terminos');
  console.log('  de cuatro filtros estaban muertos SOLO por ir entrecomillados.');
}
if (!nuevos.length && !resueltos.length) console.log('sin cambios respecto a la línea base.');

process.exit(nuevos.length > 0 ? 1 : (falloTransporte.length > 0 || noEvaluables.length > 0 ? 2 : 0));
