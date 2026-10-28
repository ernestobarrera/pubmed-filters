#!/usr/bin/env node
/**
 * Batería con red de la 1.14.1: QUÉ ESCONDE CADA ORDEN, medido en la clase y no en un caso.
 *
 *   node scripts/eval/run-order-age.mjs --out <carpeta>
 *
 * POR QUÉ EXISTE. `reading_and_drilldown.order_hides_by_age` sale de un solo caso (lumbalgia, 2026-10-26): una
 * revisión de 2026 quedó 17.ª por relevancia y 1.ª por el orden por defecto. Antes de servirla como regla
 * hay que ver si su clase existe fuera de ese caso.
 *
 * QUÉ MIDE, con la MISMA consulta y cambiando solo `sort` (omitido o `relevance`):
 *   1. en cada pasada de la unidad de `contract_1_11` (y la de síntesis del caso L tal como se envió), la
 *      POSICIÓN de cada PMID de referencia en cada orden, con su año, y cuántos caen en los primeros 15 y
 *      50. La lista se pide entera en una llamada cuando cabe en la ventana de 9.999: así no hay páginas
 *      que puedan derivar. Lo que está en el conjunto pero más allá de la ventana se dice, no se calla;
 *   2. una SONDA SIMÉTRICA en cada pasada, más una de síntesis por caso (tema + filtro de síntesis): dónde
 *      pone `relevance` los diez primeros del orden por defecto, que son las entradas más recientes. En
 *      los casos A-P la referencia son estudios incluidos en una revisión, es decir, antiguos: solo puede
 *      mostrar el lado del orden por defecto. La sonda mide el otro lado sin elegir a mano qué es reciente;
 *   3. si dos llamadas idénticas con `relevance` devuelven la misma lista (el 20/10 no lo hicieron).
 *
 * QUÉ NO MIDE. Si una superficie lee lo que queda arriba, ni si lo de arriba es lo correcto para la
 * respuesta: una posición dice cuánto cuesta llegar a un registro en ese orden. Las posiciones son de
 * hoy, no propiedades fijas de un orden. Las estrategias son las de `cases.json`, compuestas a mano.
 *
 * Usa el ejecutor de referencia (runExact, por scripts/esearch.mjs) y la lectura con recibo (runFetch,
 * por scripts/efetch.mjs) solo para el año. Guarda en --out cada recibo íntegro y `resumen.json`. No
 * escribe en el repositorio ni fija ninguna línea base. Sale 1 si alguna búsqueda no es `verified`, si
 * una lectura no da el año o si la síntesis de L no es la auditada (SHA distinto): esas medidas no valen.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFilter, compose } from '../parse-filter.mjs';
import { runExact, sha256 } from '../exact-core.mjs';
import { runFetch } from '../fetch-core.mjs';
import { runContext } from '../pubmed-exact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const outArg = process.argv.indexOf('--out');
if (outArg < 0 || !process.argv[outArg + 1]) {
  console.error('Uso: node scripts/eval/run-order-age.mjs --out <carpeta>');
  process.exit(2);
}
const OUT = resolve(process.argv[outArg + 1]);
mkdirSync(join(OUT, 'recibos'), { recursive: true });

const spec = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));
const filt = (p) => parseFilter(readFileSync(join(ROOT, p), 'utf8'));
const WINDOW = 9999;
const HEADS = [15, 50];
const PROBE = 10;
const KEY = process.env.NCBI_API_KEY ?? '';
const PAUSE = KEY ? 150 : 450;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SYNTHESIS = 'filters/methodology/metaanalysis.txt';

// La misma composición que buildQuery de run-eval.mjs, que no se puede importar sin ejecutar su batería.
function buildQuery(pass) {
  let q = spec.topics[pass.topic];
  if (!q) throw new Error(`tema desconocido: ${pass.topic}`);
  if (pass.or_concept) {
    const parts = [spec.concept_vocabulary[pass.or_concept.vocabulary], ...pass.or_concept.filters.map((p) => `(${filt(p)})`)];
    q = `(${q}) AND (${parts.join(' OR ')})`;
  }
  for (const p of pass.and ?? []) q = compose(q, filt(p));
  return q;
}

// La síntesis de L tal como la envió la respuesta auditada: sin el paréntesis que añade compose. Misma
// lógica; se ejecuta aparte para comprobar que el paréntesis no cambia el conjunto.
const L_SYNTHESIS_SENT = `(${spec.topics.lbp_muscle_relaxants}) AND ${filt(SYNTHESIS)}`;
const L_SYNTHESIS_SHA = 'f640b14812a31e0ca626a11a05f2ff681fc242f459f9b0f1cf41729e4c693d53';

const run = await runContext();
const failures = [];
const retries = [];
let calls = 0;

/** Una búsqueda, con reintento de la MISMA llamada ante 429/5xx; nunca se toca la consulta. */
async function search(query, { retmax, sort, file }) {
  let receipt;
  for (let attempt = 1; ; attempt++) {
    await sleep(PAUSE);
    calls++;
    try {
      receipt = await runExact(query, { retmax, ...(sort ? { sort } : {}), apiKey: KEY, run, engine: 'scripts/eval/run-order-age.mjs' });
      break;
    } catch (e) {
      if (!/HTTP (429|5\d\d)/.test(e.message) || attempt >= 4) throw e;
      retries.push(`${file}: ${e.message}`);
      await sleep(3000 * attempt);
    }
  }
  writeFileSync(join(OUT, 'recibos', `${file}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.status?.query_integrity !== 'verified') failures.push(`${file}: query_integrity ${receipt.status?.query_integrity}`);
  return receipt;
}

/** Años por PMID con la lectura con recibo, de cinco en cinco; lo pendiente se vuelve a pedir. */
const years = new Map();
async function fetchYears(pmids, tag) {
  let queue = [...new Set(pmids)].filter((p) => !years.has(p));
  let batch = 0;
  while (queue.length) {
    const chunk = queue.slice(0, 5);
    queue = queue.slice(5);
    await sleep(PAUSE);
    calls++;
    const r = await runFetch(chunk, { plan_ref: 'orden-clase', read_id: `${tag}-${++batch}` },
      { apiKey: KEY, run, engine: 'scripts/eval/run-order-age.mjs' });
    writeFileSync(join(OUT, 'recibos', `lectura-${tag}-${batch}.json`), `${JSON.stringify(r, null, 2)}\n`);
    for (const x of r.results ?? []) {
      if (['with_abstract', 'without_abstract'].includes(x.record_status)) years.set(x.requested_pmid, x.year ?? null);
    }
    // pending_pmids son objetos { pmid, reason }: lo que no cupo en el recibo se pide otra vez.
    const pending = (r.pending_pmids ?? []).map((x) => x.pmid);
    queue.push(...pending.filter((p) => !years.has(p)));
    for (const p of chunk) if (!years.has(p) && !pending.includes(p)) {
      years.set(p, null);
      failures.push(`año de ${p}: ${r.results?.find((x) => x.requested_pmid === p)?.record_status ?? 'sin resultado'}`);
    }
  }
}

const position = (list, pmid) => { const i = list.indexOf(pmid); return i < 0 ? null : i + 1; };
const median = (xs) => { const s = xs.filter((x) => x !== null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

/** Mide una pasada en los dos órdenes (relevance dos veces) y devuelve posiciones, cabezas y sonda. */
async function measure(caseId, pass, query, refs) {
  const tag = `${caseId}-${pass.id}`;
  const def = await search(query, { retmax: WINDOW, file: `${tag}-defecto` });
  const rel1 = await search(query, { retmax: WINDOW, sort: 'relevance', file: `${tag}-relevance-1` });
  const rel2 = await search(query, { retmax: WINDOW, sort: 'relevance', file: `${tag}-relevance-2` });
  const count = def.result_count;
  const inWindow = count !== null && count <= WINDOW;
  // Pertenencia de la referencia al conjunto, aparte de la posición: lo que cae fuera de la ventana no
  // es «no está».
  let members = [];
  if (refs.length) {
    const m = await search(`(${query}) AND (${refs.map((p) => `${p}[uid]`).join(' OR ')})`, { retmax: refs.length, file: `${tag}-pertenencia` });
    members = m.pmids;
  }
  const ref = refs.map((pmid) => {
    const inSet = members.includes(pmid);
    const pd = position(def.pmids, pmid);
    const pr1 = position(rel1.pmids, pmid);
    const pr2 = position(rel2.pmids, pmid);
    return { pmid, in_set: inSet, default: pd, relevance: pr1, relevance_repeat: pr2,
      beyond_window: inSet && (pd === null || pr1 === null) };
  });
  const heads = Object.fromEntries(HEADS.map((n) => [n, {
    default: ref.filter((r) => r.default !== null && r.default <= n).length,
    relevance: ref.filter((r) => r.relevance !== null && r.relevance <= n).length,
  }]));
  const newest = def.pmids.slice(0, PROBE);
  const probe = newest.map((pmid) => ({ pmid, relevance: position(rel1.pmids, pmid) }));
  return {
    query_sha256: def.sent_query_sha256, result_count: count, records_retrieved: def.records_retrieved,
    whole_set_in_one_call: inWindow && def.records_retrieved === count,
    relevance_repeat_same_list: rel1.pmid_list_sha256 === rel2.pmid_list_sha256,
    reference: ref, in_set: ref.filter((r) => r.in_set).length, heads,
    probe: { newest_by_default: probe,
      relevance_median: median(probe.map((p) => p.relevance)),
      relevance_beyond_15: probe.filter((p) => p.relevance === null || p.relevance > 15).length,
      relevance_beyond_50: probe.filter((p) => p.relevance === null || p.relevance > 50).length },
  };
}

const summary = {
  measured_at: new Date().toISOString(),
  evaluated_tree: run,
  node: process.version,
  script_sha256: await sha256(readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(/\r\n/g, '\n')),
  cases_sha256: await sha256(readFileSync(join(HERE, 'cases.json'), 'utf8').replace(/\r\n/g, '\n')),
  heads: HEADS, probe_size: PROBE, window: WINDOW,
  note: 'Posiciones de hoy, no propiedades fijas de un orden. La sonda mide dónde pone relevance las entradas más recientes; la referencia de A-P son estudios incluidos en una revisión, es decir, antiguos.',
  cases: {},
};

for (const kase of spec.cases) {
  const refs = kase.reference.pmids;
  const out = { question: kase.question, reference_kind: kase.reference.kind, reference_size: refs.length, passes: {} };
  summary.cases[kase.id] = out;
  const unit = kase.strategies.contract_1_11.filter((p) => p.unit);
  for (const pass of unit) {
    out.passes[pass.id] = { role: 'unit', ...(await measure(kase.id, pass, buildQuery(pass), refs)) };
  }
  const synthesisTopic = unit[0].topic;
  if (!unit.some((p) => (p.and ?? []).includes(SYNTHESIS))) {
    const probePass = { id: 'sonda-sintesis', topic: synthesisTopic, and: [SYNTHESIS] };
    out.passes['sonda-sintesis'] = { role: 'probe', ...(await measure(kase.id, probePass, buildQuery(probePass), [])) };
  }
  if (kase.id === 'L') {
    const sent = await sha256(L_SYNTHESIS_SENT);
    if (sent !== L_SYNTHESIS_SHA) failures.push(`L: la síntesis no es la auditada (${sent.slice(0, 8)} ≠ ${L_SYNTHESIS_SHA.slice(0, 8)})`);
    out.passes['synthesis-as-sent'] = { role: 'unit, audited string', ...(await measure(kase.id, { id: 'synthesis-as-sent' }, L_SYNTHESIS_SENT, refs)) };
  }
}

// Años: referencia y sonda, con la lectura con recibo.
const toDate = Object.values(summary.cases).flatMap((c) => Object.values(c.passes))
  .flatMap((p) => [...p.reference.map((r) => r.pmid), ...p.probe.newest_by_default.map((x) => x.pmid)]);
await fetchYears(toDate, 'anos');
for (const c of Object.values(summary.cases)) {
  for (const p of Object.values(c.passes)) {
    for (const r of p.reference) r.year = years.get(r.pmid) ?? null;
    for (const x of p.probe.newest_by_default) x.year = years.get(x.pmid) ?? null;
  }
}
summary.calls = calls;
summary.retries = retries;
summary.failures = failures;
writeFileSync(join(OUT, 'resumen.json'), `${JSON.stringify(summary, null, 2)}\n`);

// Tabla en texto, una fila por pasada.
for (const [id, c] of Object.entries(summary.cases)) {
  console.log(`\n${id} · ${c.question}`);
  for (const [pid, p] of Object.entries(c.passes)) {
    const h = p.heads;
    console.log(`  ${pid.padEnd(28)} n=${String(p.result_count).padStart(6)}  ref ${p.in_set}/${c.reference_size}`
      + `  ≤15 def ${h[15].default} rel ${h[15].relevance}  ≤50 def ${h[50].default} rel ${h[50].relevance}`
      + `  sonda: mediana rel ${p.probe.relevance_median}, >15 ${p.probe.relevance_beyond_15}/${PROBE}`
      + `  rel repetida igual: ${p.relevance_repeat_same_list}`);
    for (const r of p.reference.filter((x) => x.in_set)) {
      console.log(`      ${r.pmid} (${r.year ?? '?'})  defecto ${r.default ?? '>ventana'}  relevance ${r.relevance ?? '>ventana'}${r.relevance_repeat !== r.relevance ? ` / ${r.relevance_repeat}` : ''}`);
    }
  }
}
console.log(`\n${calls} llamadas · ${retries.length} reintentos · ${failures.length} fallos${failures.length ? `: ${failures.join('; ')}` : ''}`);
console.log(`resumen: ${join(OUT, 'resumen.json')}`);
process.exit(failures.length ? 1 : 0);
