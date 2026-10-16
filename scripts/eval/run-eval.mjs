#!/usr/bin/env node
/**
 * Batería de evaluación de la SELECCIÓN de filtros: qué recupera cada versión del contrato, no si la
 * consulta corrió íntegra (eso lo prueban la suite y el recibo).
 *
 *   node scripts/eval/run-eval.mjs                 ejecuta y compara con la línea base
 *   node scripts/eval/run-eval.mjs --fijar-base    reescribe la línea base con lo medido hoy
 *
 * POR QUÉ EXISTE. Hasta la 1.10 la suite comprobaba que las reglas de selección existían, nunca qué
 * recuperaban. Con cuatro casos de la Fase 0 se midió que dos reglas, aplicadas tal como estaban
 * escritas, perdían evidencia sin ninguna señal. Esto convierte esa medida en algo repetible.
 *
 * CÓMO MIDE. Cada caso de `cases.json` fija antes de ejecutar: pregunta, facetas con su papel esperado y
 * un conjunto de estudios INCLUIDOS por una revisión independiente. Cada pasada se ejecuta dos veces con
 * el ejecutor de referencia: una para el recuento, otra intersecada con la referencia. La retención de
 * la unidad de la afirmación (coverage_check.unit) es la unión de las pasadas de esa unidad.
 *
 * QUÉ NO MIDE. Lo que hace de verdad una superficie conversacional: las estrategias están compuestas a
 * mano a partir del texto de cada contrato. Ni la precisión, más allá de los recuentos.
 *
 * NO forma parte de la suite ni de la CI: necesita red y PubMed cambia. Como el barrido, guarda una
 * línea base y habla de lo que cambia.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFilter, compose } from '../parse-filter.mjs';
import { runExact, sha256 } from '../exact-core.mjs';
import { runContext } from '../pubmed-exact.mjs';
import { roleConformance } from './conformance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const BASE = join(HERE, 'baseline.json');
const spec = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));
const router = JSON.parse(readFileSync(join(ROOT, 'neurosymbolic_router.json'), 'utf8'));
const roleOf = router.filter_catalog?.role_of ?? {};
const KEY = process.env.NCBI_API_KEY ?? '';
const PAUSE = KEY ? 120 : 380;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const filt = (p) => parseFilter(readFileSync(join(ROOT, p), 'utf8'));

export function buildQuery(pass) {
  let q = spec.topics[pass.topic];
  if (!q) throw new Error(`tema desconocido: ${pass.topic}`);
  if (pass.or_concept) {
    const parts = [spec.concept_vocabulary[pass.or_concept.vocabulary], ...pass.or_concept.filters.map((p) => `(${filt(p)})`)];
    q = `(${q}) AND (${parts.join(' OR ')})`;
  }
  for (const p of pass.and ?? []) q = compose(q, filt(p));
  return q;
}

/** Activación innecesaria: AND de un filtro de ámbito o editorial para una faceta que no es núcleo. */
function unnecessaryActivations(kase, passes) {
  const nonCore = new Set(kase.facets.filter((f) => f.expected_role !== 'core').flatMap((f) => f.filters ?? []));
  return passes.filter((p) => p.unit).flatMap((p) => (p.and ?? [])
    .filter((f) => nonCore.has(f) && ['population_setting', 'editorial'].includes(roleOf[f])).map((f) => `${p.id}:${f}`));
}

// Un 5xx de NCBI es transitorio: se repite la MISMA consulta, hasta tres veces. Nunca se acorta ni se
// toca (transport_carries_the_whole_query); un 413/414 no se repite, es un fallo de transporte.
let reintentos = 0;
async function run(term, retmax) {
  for (let intento = 1; ; intento++) {
    await sleep(PAUSE * intento);
    try {
      return await runExact(term, { retmax, apiKey: KEY, tool: 'pubmed-filters-eval' });
    } catch (err) {
      if (intento >= 3 || !/^HTTP 5\d\d$/.test(err.message)) throw err;
      reintentos++;
    }
  }
}

// Qué se evaluó, sin ambigüedad: el contrato del ÁRBOL (no el de las estrategias, que llevan cada una su
// versión en su nombre), el commit y los hashes del router, el catálogo y la especificación de casos.
const run0 = await runContext();
const results = {
  medido_el: new Date().toISOString().slice(0, 10),
  evaluated_tree: { ...run0, cases_sha256: await sha256(readFileSync(join(HERE, 'cases.json'), 'utf8').replace(/\r\n/g, '\n')) },
  note: 'Strategy keys (risk_under_1_10, conformant_1_10, contract_1_11, forbidden_1_11) are hand-composed readings of each contract version, all run against this tree.',
  cases: {},
};
process.on('exit', () => { if (reintentos) console.log(`(reintentos por 5xx de NCBI: ${reintentos})`); });

// Antes de gastar una sola consulta: ¿respetan las estrategias 1.11 el papel declarado de cada faceta?
const conformidad = roleConformance(spec, roleOf);
if (conformidad.length) {
  console.error(`ESPECIFICACIÓN INCOHERENTE con los papeles declarados:\n  ${conformidad.join('\n  ')}`);
  process.exit(1);
}
for (const kase of spec.cases) {
  const ref = kase.reference.pmids;
  const refClause = ref.map((p) => `${p}[pmid]`).join(' OR ');
  results.cases[kase.id] = { reference_size: ref.length, reference_complete: kase.reference.complete, versions: {} };
  for (const [version, passes] of Object.entries(kase.strategies)) {
    const out = { passes: [], unit_hits: [], integrity: 'verified' };
    for (const pass of passes) {
      const q = buildQuery(pass);
      const n = await run(q, 0);
      const hit = await run(`(${q}) AND (${refClause})`, ref.length);
      if (n.status?.query_integrity !== 'verified' || hit.status?.query_integrity !== 'verified') out.integrity = 'not_verified';
      out.passes.push({ id: pass.id, unit: Boolean(pass.unit), result_count: n.result_count, hits: hit.pmids.length,
        integrity: n.status?.query_integrity, query_sha256: n.sent_query_sha256 });
      if (pass.unit) out.unit_hits.push(...hit.pmids);
    }
    out.unit_hits = [...new Set(out.unit_hits)].sort();
    out.unit_retention = `${out.unit_hits.length}/${ref.length}`;
    out.missed = ref.filter((p) => !out.unit_hits.includes(p));
    out.passes_run = passes.length;
    out.unnecessary_activations = unnecessaryActivations(kase, passes);
    results.cases[kase.id].versions[version] = out;
  }
}

// Informe
for (const [id, c] of Object.entries(results.cases)) {
  console.log(`\nCaso ${id} · referencia ${c.reference_size}${c.reference_complete ? '' : ' (parcial)'}`);
  for (const [v, o] of Object.entries(c.versions)) {
    const counts = o.passes.map((p) => `${p.id}=${p.result_count}`).join(' ');
    console.log(`  ${v.padEnd(15)} retención ${o.unit_retention.padStart(5)} · pasadas ${o.passes_run} · activaciones innecesarias ${o.unnecessary_activations.length} · ${o.integrity} · ${counts}`);
  }
}

// Una medida sin integridad verificada no se interpreta, ni se aprueba, ni se fija como base. Revisión de
// Codex del 2026-10-16: la versión anterior marcaba not_verified y seguía, y el comparador acababa en 0.
const sinVerificar = Object.entries(results.cases).flatMap(([id, c]) => Object.entries(c.versions)
  .filter(([, o]) => o.integrity !== 'verified').map(([v]) => `${id}.${v}`));
if (sinVerificar.length) {
  console.error(`\nINTEGRIDAD NO VERIFICADA en ${sinVerificar.join(', ')}: estas medidas no valen, ni para aprobar ni como base.`);
  process.exit(1);
}

// Lo que no puede cambiar sin que se diga: retención, activaciones, número de pasadas y la CONSULTA de
// cada pasada (su hash). Retirar la restricción de P conservaba 11/11 y el comparador anterior no lo veía.
const essential = (r) => Object.fromEntries(Object.entries(r.cases).map(([id, c]) => [id,
  Object.fromEntries(Object.entries(c.versions).map(([v, o]) => [v, {
    unit_retention: o.unit_retention, unnecessary: o.unnecessary_activations.length, passes_run: o.passes_run,
    queries: o.passes.map((p) => `${p.id}:${p.query_sha256}`) }]))]));
// El coste (registros) cambia cada día con la indexación: se muestra siempre y solo falla si se dobla o
// se reduce a la mitad, que ya no es indexación sino otra consulta u otro PubMed.
const counts = (r) => Object.entries(r.cases).flatMap(([id, c]) => Object.entries(c.versions)
  .flatMap(([v, o]) => o.passes.map((p) => [`${id}.${v}.${p.id}`, p.result_count])));

if (process.argv.includes('--fijar-base')) {
  writeFileSync(BASE, `${JSON.stringify({ ...results }, null, 2)}\n`);
  console.log(`\nlínea base fijada en ${BASE}`);
} else if (existsSync(BASE)) {
  const baseRaw = JSON.parse(readFileSync(BASE, 'utf8'));
  const before = essential(baseRaw);
  const now = essential(results);
  const changed = [...new Set([...Object.keys(now), ...Object.keys(before)])]
    .filter((id) => JSON.stringify(now[id]) !== JSON.stringify(before[id]));
  const prev = Object.fromEntries(counts(baseRaw));
  const costes = counts(results).filter(([k, n]) => prev[k] != null && n !== prev[k]).map(([k, n]) => {
    const ratio = prev[k] === 0 ? (n === 0 ? 1 : Infinity) : n / prev[k];
    return { k, de: prev[k], a: n, grave: ratio > 2 || ratio < 0.5 };
  });
  if (costes.length) console.log(`\nregistros que cambian: ${costes.map((c) => `${c.k} ${c.de}→${c.a}${c.grave ? ' (GRAVE)' : ''}`).join(' · ')}`);
  const graves = costes.filter((c) => c.grave);
  console.log(changed.length ? `\nCAMBIOS respecto a la línea base: ${changed.join(', ')}` : '\nsin cambios de retención, activaciones ni consultas.');
  process.exit(changed.length || graves.length ? 1 : 0);
}
