#!/usr/bin/env node
/**
 * Puerta de mutación: comprueba que la suite de conformidad SABE RECHAZAR una implementación mala.
 *
 * POR QUÉ EXISTE. Una suite en verde no prueba nada por sí sola: prueba que nada de lo que mira
 * está roto, que es distinto. Tres veces en septiembre de 2026 una comprobación de este repositorio
 * o de un adaptador suyo estuvo vigilando un fallo **que ya estaba presente**:
 *
 *   · las pruebas de transporte de `qa-pubmed.mjs` miraban el constructor de la petición, no la
 *     petición entregada: truncar el cuerpo después de construirlo dejaba la suite en verde;
 *   · el resumen de esa misma suite se calculaba antes de sus últimas comprobaciones, así que
 *     imprimía los fallos y devolvía código 0;
 *   · una comprobación acreditaba POST buscando la cadena `method: 'POST'` en el fichero, de modo
 *     que dejarla en un comentario y enviar un GET real pasaba 48/0.
 *
 * Las tres las encontró una persona o otro agente leyendo el código. Ninguna la encontró el banco.
 * Esta puerta convierte esa lectura en algo que corre en CI: cada mutación de la tabla tiene que
 * romper la comprobación que dice vigilarla. Si una mutación pasa, la comprobación es decorativa y
 * esta puerta falla.
 *
 * CÓMO FUNCIONA. Muta el fichero EN SITIO, ejecuta la suite en otro proceso, y restaura siempre
 * —haya ido bien o mal—. Se niega a arrancar si el árbol de git está sucio, para que un corte a
 * mitad no pueda llevarse por delante trabajo sin guardar. Al terminar verifica que el contenido
 * restaurado es byte a byte el original.
 *
 * Uso:  node scripts/validate-mutations.mjs
 * Sale: 0 si todas las mutaciones se detectan, 1 si alguna sobrevive.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = join(ROOT, 'scripts', 'validate-router.mjs');

/**
 * Cada entrada es una forma concreta de equivocarse, tomada de un fallo real o de la clase de fallo
 * que una comprobación dice cubrir. `rompe` es la comprobación que DEBE caer: si cae otra y no esa,
 * la comprobación no vigila lo que cree vigilar y esto también se declara fallo.
 */
const MUTACIONES = [
  {
    id: 'T1-GET',
    porque: 'la consulta vuelve a viajar por GET: el fallo que la 1.8.0 cerro',
    fichero: 'scripts/esearch.mjs',
    de: '{ method: TRANSPORT, body }',
    a: "{ method: 'GET', body }",
    rompe: 'T1',
  },
  {
    id: 'T1-TRUNCA',
    porque: 'el cuerpo se trunca DESPUES de construirlo, que es como una prueba de transporte pasa en verde vigilando el truncado',
    fichero: 'scripts/esearch.mjs',
    de: '...params, term })',
    a: '...params, term: term.slice(0, 10) })',
    rompe: 'T1',
  },
  {
    id: 'T1-FUERA',
    porque: 'un script vuelve a hablar con el servicio por su cuenta, fuera del unico modulo que lo hace',
    fichero: 'scripts/quickstart.mjs',
    de: "import { esearch } from './esearch.mjs';",
    // La URL va partida a propósito. Escrita entera, C12 caza ESTE fichero —«servicio nombrado
    // fuera de esearch.mjs»— y la suite se pone en rojo antes de empezar. Ocurrió el 2026-09-30 al
    // añadir esta mutación: la puerta cazó a quien la escribía. Se parte aquí en vez de eximir este
    // fichero en C12, porque una exención es una comprobación un poco más floja para siempre.
    a: "import { esearch } from './esearch.mjs';\nconst _ = 'https://eutils"
      + '.ncbi.nlm.nih.gov/entrez/eutils/esearch' + ".fcgi';",
    rompe: 'C12',
  },
  {
    id: 'M1',
    porque: 'los vectores vuelven a quedarse congelados, como estaban en la 1.7.1',
    fichero: 'neurosymbolic_router.json',
    // Se quita UN vector con su coma: quitar los dos dejaba una coma colgando y el JSON inválido,
    // así que la suite moría por un error de sintaxis en vez de fallar C9. Una mutación que rompe el
    // fichero no prueba que la comprobación funcione; prueba que JSON.parse funciona.
    de: ',\n        "dropped_term_with_results"',
    a: '',
    rompe: 'C9',
  },
  {
    id: 'M2',
    porque: 'sin declarar qué es prosa rectora, cualquier regla puede eximirse sola',
    fichero: 'neurosymbolic_router.json',
    de: '"guiding_prose_not_a_vector"',
    a: '"guiding_prose_not_a_vector_DESACTIVADO"',
    rompe: 'C9',
  },
  {
    id: 'M3',
    porque: 'un recuento ausente o no numérico vuelve a pasar por recuento (regresión de la 1.7.1)',
    fichero: 'scripts/parse-filter.mjs',
    de: 'const countIsValid = ',
    a: 'const countIsValid = true || ',
    rompe: 'Q7',
  },
  {
    id: 'M4',
    porque: 'un término descartado deja de invalidar el recuento cuando la consulta devuelve resultados',
    fichero: 'scripts/parse-filter.mjs',
    // Para que esto pruebe algo hay que vaciar `dropped`, no tocar uno de sus dos efectos. Medido el
    // 2026-09-30: `usable` lo invalidan por separado `dropped.length === 0` Y el `problems` que
    // empuja el aviso, así que quitar uno solo deja la suite en verde sin que la comprobación sea
    // mala — es un mutante EQUIVALENTE. Es defensa en profundidad, y conviene que se note.
    // Primera lección de esta puerta: dice de qué dudar, no dicta el veredicto.
    de: '  const dropped = [\n',
    a: '  const dropped = [];\n  const droppedIgnorado = [\n',
    rompe: 'Q6',
  },
  {
    id: 'M5',
    porque: 'una exclusión se compone con AND y PubMed la traduce como inclusión: el fallo original',
    fichero: 'scripts/parse-filter.mjs',
    de: 'export function compose(',
    a: 'export function compose(base, filter, negation) { return `(${base}) AND (${filter})`; }\nexport function composeViejo(',
    rompe: 'N3',
  },
  {
    id: 'M6',
    porque: 'el parser vuelve a quedarse con una sola línea y trunca los filtros multilínea',
    fichero: 'scripts/parse-filter.mjs',
    de: '.join(\' \')',
    a: '.slice(0, 1).join(\' \')',
    rompe: 'P1',
  },
];

// ---------------------------------------------------------------------------------------------

const arbolSucio = () => {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
  } catch {
    return null; // sin git disponible: no se puede comprobar, se dice más abajo
  }
};

const fallosDe = (salida) => [...salida.matchAll(/^\s*(?:FAIL|fail)\s+(\S+)/gm)].map((m) => m[1]);

const correrSuite = () => {
  const r = spawnSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

const sucio = arbolSucio();
if (sucio === true) {
  console.error('ABORTA: el árbol de git tiene cambios sin guardar.');
  console.error('Esta puerta muta ficheros en sitio y los restaura; con trabajo sin guardar el riesgo');
  console.error('no merece la pena. Haz commit o stash y vuelve a lanzarla.');
  process.exit(1);
}
if (sucio === null) console.log('aviso: no se pudo comprobar el estado de git; se continúa con restauración en finally.\n');

// Línea base: sin mutar, la suite tiene que estar en verde. Si no, lo que viene después no significa
// nada —una mutación «detectada» sobre un banco ya roto no prueba absolutamente nada—.
const base = correrSuite();
if (base.status !== 0) {
  console.error('ABORTA: la suite ya falla SIN mutar. Arregla eso antes: sobre un banco roto, una');
  console.error('mutación «detectada» no demuestra nada.');
  console.error(base.salida.split('\n').filter((l) => /fail/i.test(l)).join('\n'));
  process.exit(1);
}
console.log('base  la suite sin mutar está en verde\n');

const pass = [];
const fallo = [];

for (const m of MUTACIONES) {
  const ruta = join(ROOT, m.fichero);
  const original = readFileSync(ruta, 'utf8');
  if (!original.includes(m.de)) {
    fallo.push(`${m.id}  la mutación NO se puede aplicar: «${m.de.slice(0, 40)}» no está en ${m.fichero}`
      + ' — la tabla se ha quedado vieja respecto al código, y una mutación que no muta no prueba nada');
    continue;
  }
  const mutado = original.replace(m.de, m.a);
  if (mutado === original) {
    fallo.push(`${m.id}  la mutación no cambia el fichero: no prueba nada`);
    continue;
  }
  try {
    writeFileSync(ruta, mutado);
    const { status, salida } = correrSuite();
    const caidas = fallosDe(salida);
    if (status === 0) {
      fallo.push(`${m.id}  SOBREVIVE: ${m.porque} — la suite sigue en verde, así que ${m.rompe} es decorativa`);
    } else if (!caidas.includes(m.rompe)) {
      fallo.push(`${m.id}  rompe la suite pero NO ${m.rompe} (cayeron: ${caidas.join(', ') || 'ninguna nombrada'})`
        + ` — ${m.rompe} no vigila lo que dice vigilar`);
    } else {
      pass.push(`${m.id}  ${m.rompe} la detecta · ${m.porque}`);
    }
  } finally {
    writeFileSync(ruta, original);
    const restaurado = readFileSync(ruta, 'utf8');
    if (restaurado !== original) {
      console.error(`\nATENCIÓN: ${m.fichero} no quedó igual que estaba. Revísalo con git diff antes de seguir.`);
      process.exit(1);
    }
  }
}

for (const p of pass) console.log(`  pass  ${p}`);
for (const f of fallo) console.log(`  FAIL  ${f}`);
console.log(`\n${pass.length} mutaciones detectadas / ${fallo.length} sin detectar`);
if (arbolSucio() === true) {
  console.error('ATENCIÓN: el árbol quedó sucio al terminar. Revisa git diff: la restauración falló.');
  process.exit(1);
}
process.exit(fallo.length === 0 ? 0 : 1);
