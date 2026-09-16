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
 * NO forma parte de la suite ni de la CI: necesita red y depende de un servicio externo. Se ejecuta
 * a mano cuando se añaden filtros o de tarde en tarde. Respeta el límite de 3 peticiones por segundo
 * de NCBI; con una clave de API en NCBI_API_KEY va algo más rápido.
 *
 * Distingue dos cosas que no son iguales:
 *   - una frase de texto libre que simplemente no aparece en la literatura (aviso benigno);
 *   - un término dirigido a un campo donde no existe (no aporta nada y parece que sí).
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFilter, isNegation, inspectResponse } from './parse-filter.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const KEY = process.env.NCBI_API_KEY ?? '';
const PAUSE = KEY ? 120 : 380;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function esearch(term) {
  const body = new URLSearchParams({
    db: 'pubmed', term, retmode: 'json', retmax: '0',
    tool: 'pubmed-filters-sweep', ...(KEY ? { api_key: KEY } : {}),
  });
  for (let intento = 0; intento < 3; intento += 1) {
    await sleep(PAUSE);
    try {
      const res = await fetch(EUTILS, { method: 'POST', body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).esearchresult;
    } catch (e) {
      if (intento === 2) return { _error: String(e) };
      await sleep(2000);
    }
  }
  return { _error: 'sin respuesta' };
}

const files = ['methodology', 'clinical', 'scope', 'candidates'].flatMap((d) => {
  const dir = join(ROOT, 'filters', d);
  return existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => `filters/${d}/${f}`)
    : [];
});

console.log(`Barriendo ${files.length} filtros contra PubMed${KEY ? ' (con clave de API)' : ''}...\n`);

let limpios = 0;
const sucios = [];
const noEvaluables = [];

for (const f of files) {
  const q = parseFilter(readFileSync(join(ROOT, f), 'utf8'));
  // Una cláusula de exclusión aislada no es ejecutable: se ancla a un tema neutro para poder verla.
  const term = isNegation(q) ? `(humans[mh]) ${q}` : q;
  const r = await esearch(term);
  if (r._error) { noEvaluables.push([f, r._error]); continue; }
  const juicio = inspectResponse(r);
  if (juicio.dropped.length > 0) sucios.push([f, Number(r.count), juicio.dropped]);
  else limpios += 1;
}

console.log(`limpios: ${limpios}   con términos descartados: ${sucios.length}   `
  + `no evaluables: ${noEvaluables.length}\n`);
for (const [f, n, dropped] of sucios) {
  console.log(`${f}   count=${n.toLocaleString('es-ES')}`);
  for (const t of dropped) console.log(`    descartado: ${t}`);
}
for (const [f, e] of noEvaluables) console.log(`${f}   NO EVALUABLE: ${e}`);

if (sucios.length > 0) {
  console.log('\nAntes de tocar nada, tría cada caso:');
  console.log('  ¿es una frase de texto libre que no existe en la literatura? Aviso benigno.');
  console.log('  ¿es un término dirigido a un campo donde no existe? Está muerto: mide qué aporta');
  console.log('  arreglarlo antes de editar un filtro publicado y referenciado.');
}
process.exit(noEvaluables.length > 0 ? 2 : 0);
