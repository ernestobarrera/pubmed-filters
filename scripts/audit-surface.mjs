#!/usr/bin/env node
/**
 * Audita una ejecución hecha desde una superficie conversacional (ChatGPT, claude.ai) a partir del archivo
 * de recibos que conservó el propio modelo: un JSONL con una línea `{ tool, request, response }` por llamada.
 *
 *   node scripts/audit-surface.mjs recibos.jsonl [--respuesta respuesta.md] [--perlas perlas.json] [--salida carpeta] [--en-linea]
 *
 * Convierte el archivo en un dossier (manifiesto, un fichero por recibo, respuesta y referencia), lo pasa
 * por dossier-check.mjs y escribe en la carpeta de salida `dossier-check.json` e `informe.md`. Sale con el
 * código del comprobador: 0 consistent, 1 incomplete, 2 inconclusive.
 *
 * Sin `--en-linea`, local y sin red. No rehace búsquedas ni lecturas, no rellena lo que falta y no interpreta
 * clínicamente. Lo archivó el modelo: sin un registro de cierre externo, una superficie no pasa de
 * `inconclusive`, porque nada prueba que el archivo tenga todas las llamadas. Los planes admitidos son los que
 * declaran los propios recibos. Las perlas (`--perlas`) son una referencia de retención: una lista de PMID o un
 * `pubmed-dossier-reference`.
 *
 * Con `--en-linea`, dos comprobaciones con NCBI que no tocan el material (ver `onlineChecks`): las perlas
 * dentro del conjunto entero de cada pasada y la relectura de los abstracts cuya huella no cuadra. Usa
 * NCBI_API_KEY y NCBI_EMAIL si están en el entorno, sin escribirlos.
 *
 * Desde la 1.2.0 (router 1.16.0), sin red: cada catálogo archivado se compara con el que construye este
 * commit para los mismos argumentos, y el informe da G1-G2 por recibo, G3 separando lo medido de lo declarado
 * y G4 por etapa, sin veredicto conjunto de G3 y G4 (38- §9, R1).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDossier, checkFetchReceipt, referenceFrom, FORMATS, LIMITS, safePath } from './dossier-check.mjs';
import { runExact, sha256 } from './exact-core.mjs';
import { runContext } from './pubmed-exact.mjs';
import { runFetch, sha256Bytes, FETCH_RECEIPT_TYPE } from './fetch-core.mjs';
import { SUMMARY_RECEIPT_TYPE } from './summary-core.mjs';
import { OPERATIONAL } from './page-union.mjs';
import { buildFilterBundle } from './filter-source.mjs';
import { createMcpHandler } from '../mcp/protocol.mjs';

export const AUDITOR_VERSION = '1.2.0';
const DOSSIER_TOOLS = ['pubmed_search_exact', 'pubmed_fetch_exact', 'pubmed_summary_exact'];
const CONTEXT_TOOLS = ['pubmed_filter_catalog', 'pubmed_get_filter'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const enc = (s) => new TextEncoder().encode(s);
const payloadOf = (response) => (isObj(response) && isObj(response.structuredContent) ? response.structuredContent : null);

/** La herramienta de una línea que solo trae la respuesta, deducida de la forma de su recibo. */
function inferTool(p) {
  if (!isObj(p)) return null;
  if (p.receipt_type === FETCH_RECEIPT_TYPE) return 'pubmed_fetch_exact';
  if (p.receipt_type === SUMMARY_RECEIPT_TYPE) return 'pubmed_summary_exact';
  if (typeof p.sent_query_sha256 === 'string' || ('result_count' in p && typeof p.error === 'string')) return 'pubmed_search_exact';
  if (Array.isArray(p.filters) && isObj(p.counts)) return 'pubmed_filter_catalog';
  if (typeof p.path === 'string' && 'how_to_compose' in p) return 'pubmed_get_filter';
  return null;
}

/**
 * La referencia de perlas, en cualquiera de sus formas, como `pubmed-dossier-reference` ya validada con el
 * mismo criterio del comprobador. Devuelve `{ ref }` o `{ error }`, nunca una referencia a medias.
 */
export function referenceFromPerlas(json) {
  let ref = null;
  if (Array.isArray(json)) {
    ref = { format: FORMATS.reference, format_version: 1, reference_id: 'perlas', version: null, source: 'perlas declaradas por quien audita',
      partial: true, target_pmids: json, synthesis_pmids: [] };
  } else if (isObj(json) && json.format === FORMATS.reference) ref = json;
  else if (isObj(json) && Array.isArray(json.target_pmids)) {
    ref = { format: FORMATS.reference, format_version: 1, reference_id: json.reference_id ?? 'perlas', version: json.version ?? null,
      source: json.source ?? 'perlas declaradas por quien audita', partial: json.partial !== false, target_pmids: json.target_pmids,
      synthesis_pmids: json.synthesis_pmids ?? [] };
  }
  if (!ref) return { error: 'perlas: ni lista de PMID ni pubmed-dossier-reference' };
  const checked = referenceFrom(ref);
  return checked.error ? { error: `perlas: ${checked.error}` } : { ref };
}

const SEARCH_ARGS = ['query', 'retmax', 'retstart', 'sort', 'filters_used', 'selection_record'];
const READ_ARGS = ['pmids', 'context'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Igualdad por campos y valores, sin dar significado al orden de las claves: el servidor fija el suyo
// (revisión de Codex del delta, Δ1).
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const sameFields = (a, b) => canon(a) === canon(b);

/**
 * La petición archivada frente a lo que acredita su recibo, campo a campo y con los valores por defecto del
 * MCP: en una búsqueda, consulta, tamaño PEDIDO (no el acotado por el servidor), desplazamiento, orden,
 * filtros declarados y registro de selección (por su huella, la misma que calcula el servidor); en lectura y
 * cribado, PMID y contexto. Un `null` no es omitir: el servidor lo rechaza en `retstart`, `sort`,
 * `filters_used` y `selection_record`, y solo en `retmax` lo toma por su valor por defecto. Devuelve los
 * campos distintos y los que no se pudieron comparar.
 */
async function compareRequest(tool, asked, p) {
  const mismatched = [];
  const uncomparable = [];
  if (!isObj(asked)) return { mismatched, uncomparable: ['la petición entera (no es un objeto)'] };
  const known = tool === 'pubmed_search_exact' ? SEARCH_ARGS : READ_ARGS;
  uncomparable.push(...Object.keys(asked).filter((k) => !known.includes(k)));
  const check = (field, archived, certified, equal = same) => {
    if (certified === undefined) uncomparable.push(field);
    else if (!equal(archived, certified)) mismatched.push(field);
  };
  if (tool === 'pubmed_search_exact' && typeof p.sent_query_sha256 !== 'string') {
    // Búsqueda fallida: su recibo solo acredita la consulta enviada.
    check('query', asked.query, p.sent_query);
    uncomparable.push(...SEARCH_ARGS.filter((k) => k !== 'query' && Object.hasOwn(asked, k)));
  } else if (tool === 'pubmed_search_exact') {
    check('query', asked.query, p.sent_query);
    if (!isObj(p.request)) { uncomparable.push('retmax', 'retstart', 'sort'); } else {
      check('retmax', asked.retmax ?? 0, p.request.retmax_requested);
      check('retstart', Object.hasOwn(asked, 'retstart') ? asked.retstart : 0, p.request.retstart);
      if (asked.sort === null) mismatched.push('sort');
      else check('sort', asked.sort ?? null, p.request.sort);
    }
    const declared = Array.isArray(p.filter_fidelity) ? p.filter_fidelity.map((f) => f?.declared) : null;
    if (!Object.hasOwn(asked, 'filters_used') ? declared !== null
      : !Array.isArray(asked.filters_used) || !same(asked.filters_used, declared)) mismatched.push('filters_used');
    if (!Object.hasOwn(asked, 'selection_record')) { if (p.selection_record !== undefined) mismatched.push('selection_record'); }
    else if (typeof p.selection_record?.sha256 !== 'string') mismatched.push('selection_record');
    else if (await sha256(JSON.stringify(asked.selection_record)) !== p.selection_record.sha256) mismatched.push('selection_record');
  } else {
    check('pmids', asked.pmids, p.request?.pmids);
    check('context', asked.context, p.request?.context, sameFields);
  }
  return { mismatched, uncomparable };
}

/**
 * Del archivo de la superficie a un dossier en memoria: `files` (ruta → bytes) y `manifest`. Además devuelve
 * las llamadas de contexto (catálogo y filtro), las líneas ilegibles y las peticiones archivadas que no
 * coinciden con lo que acredita su recibo.
 */
export async function buildSurfaceDossier(jsonlText, { responseBytes = null, perlas = null } = {}) {
  const files = new Map();
  const put = async (path, bytes) => { files.set(path, bytes); return { file: path, sha256: await sha256Bytes(bytes) }; };
  const unreadable = [];
  const contextCalls = [];
  const requestMismatches = [];
  const requestUncomparable = [];
  const responseOnly = [];
  const attempts = [];
  const plans = new Map();
  const admit = (plan, pass) => {
    if (typeof plan !== 'string' || !plan.trim()) return;
    const set = plans.get(plan) ?? plans.set(plan, new Set()).get(plan);
    if (typeof pass === 'string' && pass.trim()) set.add(pass);
  };
  const lines = jsonlText.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    if (!raw.trim()) continue;
    const at = `L${i + 1}`;
    let line;
    try { line = JSON.parse(raw); } catch { unreadable.push({ line: i + 1, reason: 'no es JSON' }); continue; }
    // Dos formas: { tool, request, response } o la respuesta sola, { structuredContent, content }.
    if (isObj(line) && line.tool === undefined && isObj(line.structuredContent)) {
      const tool = inferTool(line.structuredContent);
      if (!tool) { unreadable.push({ line: i + 1, reason: 'respuesta sin forma de recibo reconocible' }); continue; }
      line = { tool, response: line };
      responseOnly.push(i + 1);
    }
    if (!isObj(line) || typeof line.tool !== 'string' || !isObj(line.response)) { unreadable.push({ line: i + 1, reason: 'sin { tool, response }' }); continue; }
    const p = payloadOf(line.response);
    if (CONTEXT_TOOLS.includes(line.tool)) {
      // El texto de la envoltura, si viene, tiene que ser el JSON compacto de su estructurado (38- D3, M31).
      const text = line.response.content?.find?.((c) => c?.type === 'text')?.text;
      contextCalls.push({ line: i + 1, tool: line.tool, request: line.request ?? null,
        contract_version: p?.contract_version ?? p?.run?.contract_version ?? null, path: p?.path ?? null, payload: p,
        text: typeof text !== 'string' ? 'absent' : p && text === JSON.stringify(p) ? 'compact' : 'not_compact' });
      continue;
    }
    const tool = DOSSIER_TOOLS.includes(line.tool) ? line.tool : 'other';
    if (p && line.request !== undefined && tool !== 'other') {
      const { mismatched, uncomparable } = await compareRequest(tool, line.request, p);
      if (mismatched.length) requestMismatches.push({ line: i + 1, tool, fields: mismatched });
      if (uncomparable.length) requestUncomparable.push({ line: i + 1, tool, fields: uncomparable });
    }
    if (tool === 'pubmed_search_exact') admit(p?.selection_record?.record?.plan_ref, p?.selection_record?.record?.pass?.pass_id);
    else if (tool !== 'other') admit(p?.request?.context?.plan_ref, null);
    const ref = await put(`intentos/${String(i + 1).padStart(3, '0')}.json`, enc(JSON.stringify(line.response)));
    attempts.push({ attempt_ref: at, tool, external_id: typeof p?.attempt_id === 'string' ? p.attempt_id : null, ...ref, captured: 'transcribed' });
  }
  const manifest = {
    format: FORMATS.manifest, format_version: 1, dossier_id: `surface:${(await sha256Bytes(enc(jsonlText))).slice(0, 16)}`,
    case: null, condition: 'surface', profile: 'surface',
    capture: { method: 'surface_jsonl', inventory_by: 'model', closure: null, clock: null },
    plans: plans.size ? [...plans].map(([plan_ref, passes]) => ({ plan_ref, passes: [...passes].sort() })) : [{ plan_ref: 'sin-plan', passes: [] }],
    attempts,
  };
  if (responseBytes) manifest.response = { ...await put('respuesta.md', responseBytes), captured: 'transcribed' };
  let referenceError = null;
  if (perlas !== null) {
    const { ref, error } = referenceFromPerlas(perlas);
    if (error) referenceError = error;
    else manifest.reference = await put('referencia.json', enc(JSON.stringify(ref)));
  }
  return { files, manifest, contextCalls, unreadable, requestMismatches, requestUncomparable, responseOnly, referenceError };
}

const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
const SPECIAL_SPACE = /(?! )\p{Zs}/gu;
const passKey = (p) => JSON.stringify([p.plan_ref, p.pass_id, p.walk_id ?? null]);
const codePoints = (s) => [...new Set(s.match(SPECIAL_SPACE) ?? [])].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).sort();

/**
 * Con red, lo que el archivo no puede decir solo. Las llamadas, los recibos, los fallos y la incertidumbre del
 * auditor quedan separados del material del modelo: no cambian su veredicto, sus defectos ni sus denominadores.
 *
 * - Perlas dentro del conjunto: por cada pasada válida sin unión medida, `(<su consulta>) AND (<las perlas
 *   en OR con [pmid]>)` y, aparte, su recuento de hoy. La intersección verificada entra en el manifiesto como
 *   `intersections`, que dossier-check mide, y separa la perla que estaba en un conjunto pero fuera de toda
 *   cabecera traída de la que no estaba en ninguno. Mide el conjunto de hoy: el recuento dice si es el mismo,
 *   si cambió o si no se pudo comparar.
 * - Relectura de los abstracts cuya huella declarada no corresponde al texto archivado, uno por llamada. Solo
 *   decide una relectura íntegra y atribuible, comprobada con el mismo criterio que una lectura del dossier. Si
 *   su huella es la declarada y el texto coincide salvo espacios especiales, la copia los normalizó; si coincide
 *   la huella y no el texto, la copia lo alteró; si la huella de hoy es otra, no se decide. Dice qué le pasó a
 *   la copia, no quién la hizo.
 *
 * `search(term, retmax)` y `read(pmid, n)` devuelven recibos del ejecutor del repo; `pause()` espacia las llamadas.
 */
export async function onlineChecks(built, result, { search, read, pause = async () => {} }) {
  const files = new Map();
  const failures = [];
  const payloadAt = new Map(built.manifest.attempts.map((a) => [a.attempt_ref, payloadOf(decode(built.files.get(a.file)))]));
  const out = { perlas: null, passes: [], rereads: [], failures, files };
  const why = (e) => String(e?.message ?? e).slice(0, 160);

  const R = built.manifest.reference ? decode(built.files.get(built.manifest.reference.file)).target_pmids : null;
  const within = Array.isArray(result.retention?.within_query) ? result.retention.within_query : [];
  const measured = new Set(within.map(passKey));
  if (R && result.retention?.status === 'measured') {
    const orList = R.map((p) => `${p}[pmid]`).join(' OR ');
    for (const [i, p] of result.passes.filter((x) => x.attempts_valid.length && !measured.has(passKey(x))).entries()) {
      const queries = [...new Set(p.attempts_valid.map((ref) => payloadAt.get(ref)?.sent_query))];
      const row = { plan_ref: p.plan_ref, pass_id: p.pass_id, walk_id: p.walk_id, count_receipt: p.funnel.found, count_today: null,
        count_status: 'not_compared', intersection: null };
      out.passes.push(row);
      if (queries.length !== 1 || typeof queries[0] !== 'string') { failures.push(`${p.pass_id}: no tiene una sola consulta; sin intersección`); continue; }
      const n = String(i + 1).padStart(3, '0');
      try {
        await pause();
        const inter = await search(`(${queries[0]}) AND (${orList})`, R.length);
        if (inter?.status?.query_integrity !== 'verified' || inter?.records_complete !== true) {
          failures.push(`${p.pass_id}: intersección ${inter?.status?.query_integrity ?? 'ilegible'}${inter?.records_complete === true ? '' : ', sin la lista entera'}; no se mide`);
          files.set(`en-linea/interseccion-no-usada-${n}.json`, enc(JSON.stringify(inter ?? null)));
        } else {
          const bytes = enc(JSON.stringify(inter));
          const file = `intersecciones/${n}.json`;
          built.files.set(file, bytes);
          (built.manifest.intersections ??= []).push({ file, sha256: await sha256Bytes(bytes), plan_ref: p.plan_ref, pass_id: p.pass_id,
            ...(p.walk_id ? { walk_id: p.walk_id } : {}) });
          row.intersection = file;
        }
      } catch (e) {
        failures.push(`${p.pass_id}: intersección no obtenida (${why(e)})`);
      }
      // El recuento va aparte: si falla, la intersección no se pierde y la comparación queda sin hacer.
      try {
        await pause();
        const today = await search(queries[0], 0);
        files.set(`en-linea/recuento-${n}.json`, enc(JSON.stringify(today ?? null)));
        if (today?.status?.query_integrity === 'verified' && Number.isSafeInteger(today.result_count)) row.count_today = today.result_count;
        else failures.push(`${p.pass_id}: recuento de hoy ${today?.status?.query_integrity ?? 'ilegible'}; no se compara`);
      } catch (e) {
        failures.push(`${p.pass_id}: recuento de hoy no obtenido (${why(e)})`);
      }
      if (row.count_today !== null && Number.isSafeInteger(row.count_receipt)) row.count_status = row.count_today === row.count_receipt ? 'equal' : 'changed';
    }
  }

  const suspects = [];
  for (const a of built.manifest.attempts.filter((x) => x.tool === 'pubmed_fetch_exact')) {
    for (const x of payloadAt.get(a.attempt_ref)?.results ?? []) {
      if (x?.record_status !== 'with_abstract' || typeof x.abstract_canonical !== 'string' || typeof x.abstract_sha256 !== 'string') continue;
      if (await sha256(x.abstract_canonical) === x.abstract_sha256) continue;
      suspects.push({ attempt_ref: a.attempt_ref, pmid: x.requested_pmid, declared: x.abstract_sha256, archived: x.abstract_canonical });
    }
  }
  // Por PMID: el registro releído si la relectura es íntegra y atribuible, o el motivo por el que no decide.
  const fresh = new Map();
  for (const [i, pmid] of [...new Set(suspects.map((s) => s.pmid))].entries()) {
    let receipt;
    try {
      await pause();
      receipt = await read(pmid, i + 1);
    } catch (e) {
      fresh.set(pmid, { reason: `relectura no obtenida (${why(e)})` });
      continue;
    }
    files.set(`en-linea/relectura-${String(i + 1).padStart(3, '0')}.json`, enc(JSON.stringify(receipt ?? null)));
    const payload = payloadOf(receipt) ?? receipt;
    let check;
    try {
      check = await checkFetchReceipt(payload);
    } catch (e) {
      check = { usable: false, problems: [`no se pudo comprobar (${why(e)})`], attributable: new Set(), abstracts: [] };
    }
    // Los registros se miran solo si el validador aceptó el recibo, y en su lista ya validada: un recibo
    // ilegible no puede interrumpir el informe (revisión de Codex del delta, Δ2).
    const record = check.usable ? payload.results.find((r) => r.requested_pmid === pmid) : null;
    const abstract = check.abstracts.find((x) => x.pmid === pmid);
    const reason = !check.usable ? `relectura no válida: ${check.problems.slice(0, 3).join('; ')}`
      : !check.attributable.has(pmid) ? 'relectura sin registro atribuible a ese PMID'
        : record?.record_status !== 'with_abstract' ? `relectura sin abstract (${record?.record_status ?? 'sin registro'})`
          : !abstract?.ok ? `abstract releído no íntegro: ${abstract?.problems.join('; ') ?? 'sin comprobar'}` : null;
    fresh.set(pmid, reason ? { reason } : { record });
  }
  for (const s of suspects) {
    const f = fresh.get(s.pmid);
    const base = { attempt_ref: s.attempt_ref, pmid: s.pmid };
    if (f.reason) {
      out.rereads.push({ ...base, outcome: 'not_reread', detail: f.reason });
      if (!failures.some((x) => x.startsWith(`relectura de ${s.pmid}:`))) failures.push(`relectura de ${s.pmid}: ${f.reason}`);
    } else if (f.record.abstract_sha256 !== s.declared) {
      out.rereads.push({ ...base, outcome: 'hash_differs_today', detail: 'NCBI da hoy otro texto, o la huella declarada no era la suya: no se decide' });
    } else if (f.record.abstract_canonical.replace(SPECIAL_SPACE, ' ') === s.archived.replace(SPECIAL_SPACE, ' ')) {
      out.rereads.push({ ...base, outcome: 'normalized', detail: 'espacios especiales cambiados por espacios normales', code_points: codePoints(f.record.abstract_canonical) });
    } else out.rereads.push({ ...base, outcome: 'altered', detail: 'la huella declarada es la de hoy, pero el texto archivado difiere en algo más que espacios' });
  }
  return out;
}

/**
 * Con las intersecciones ya medidas: qué perlas no devueltas estaban en algún conjunto y cuáles en ninguno de
 * los medidos. Una pasada sin intersección, también la fallida, limita la conclusión: sin ningún conjunto
 * medido no se concluye nada; con alguno sin medir, es parcial.
 */
function splitPerlas(result, online) {
  const within = Array.isArray(result.retention?.within_query) ? result.retention.within_query : [];
  const missing = result.retention.stages[0].missing;
  const inSet = new Set(within.flatMap((w) => w.hits));
  const measured = new Set(within.map(passKey));
  const notMeasured = result.passes.filter((p) => !measured.has(passKey(p))).map((p) => p.pass_id ?? '¿?');
  online.perlas = {
    status: !within.length ? 'not_measured' : notMeasured.length ? 'partial' : 'measured', passes_not_measured: notMeasured,
    outside_head: missing.filter((p) => inSet.has(p)), outside_sets: within.length ? missing.filter((p) => !inSet.has(p)) : [],
  };
}

const list = (xs, max = 40) => (xs.length ? `${xs.slice(0, max).join(', ')}${xs.length > max ? ` y ${xs.length - max} más` : ''}` : 'ninguno');
const num = (v) => (v === null || v === undefined ? '—' : String(v));

/** Claves en las que difieren dos objetos, hasta `depth` niveles: `guidance.routing`, `counts.returned_filters`. */
const diffKeys = (a, b, depth = 2, prefix = '') => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  .filter((k) => canon(a[k]) !== canon(b[k]))
  .flatMap((k) => (depth > 1 && isObj(a[k]) && isObj(b[k]) ? diffKeys(a[k], b[k], depth - 1, `${prefix}${k}.`) : [`${prefix}${k}`]));

/**
 * Cada catálogo archivado frente al que da el manejador de este commit a los mismos argumentos (38- §9):
 * `identical`, `different` (con las claves que difieren), `other_version` si el contrato no es el mismo, o
 * `not_compared` con su motivo. `expected(args)` devuelve el `structuredContent` de referencia. Dice si lo
 * archivado es lo que sirve este commit; no que el modelo lo leyera.
 */
export async function compareCatalogs(contextCalls, expected) {
  const out = [];
  for (const c of contextCalls.filter((x) => x.tool === 'pubmed_filter_catalog')) {
    const row = { line: c.line, status: 'not_compared', reason: null, keys: [], archived_version: c.contract_version, expected_version: null, text: c.text };
    out.push(row);
    if (!expected) { row.reason = 'sin construcción de referencia'; continue; }
    if (!isObj(c.payload)) { row.reason = 'sin structuredContent'; continue; }
    if (!isObj(c.request)) { row.reason = 'sin la petición archivada: no se saben sus argumentos'; continue; }
    let want;
    try { want = await expected(c.request); } catch (e) { row.reason = `la construcción de referencia falló (${String(e?.message ?? e).slice(0, 120)})`; continue; }
    if (!isObj(want)) { row.reason = 'la construcción de referencia no dio un catálogo'; continue; }
    row.expected_version = want.contract_version ?? null;
    if (want.contract_version !== c.payload.contract_version) { row.status = 'other_version'; continue; }
    row.keys = diffKeys(c.payload, want);
    row.status = row.keys.length ? 'different' : 'identical';
  }
  return out;
}

/** La construcción de referencia: el catálogo que da el manejador del MCP con los filtros de este repositorio. */
export async function repoCatalog(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const handler = createMcpHandler({ filters: await buildFilterBundle(root) });
  let id = 0;
  return async (args) => (await handler({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
    params: { name: 'pubmed_filter_catalog', arguments: args } }))?.result?.structuredContent ?? null;
}

const PURPOSE_ORDER = { capture_sequence: 'secuencia de la captura', server_received_at: 'hora del servidor al recibir el registro' };
const CATALOG_TEXT = { compact: 'texto compacto', not_compact: 'el texto NO es el JSON compacto de su estructurado', absent: 'sin texto' };

/** Informe legible, por niveles de garantía, de lo que dice el comprobador. */
export function renderReport(result, { source, built, online = null, catalogs = [] }) {
  const r = result;
  const out = [];
  const by = (tool) => r.attempts?.filter((a) => a.tool === tool).length ?? 0;
  const findingsOf = (code) => r.findings.find((f) => f.code === code)?.pmids ?? [];
  const payloads = new Map(built.manifest.attempts.filter((a) => a.file).map((a) => [a.attempt_ref, payloadOf(decode(built.files.get(a.file)))]));
  const passName = (p) => `${p.pass_id ?? '¿?'}${p.walk_id ? ` (${p.walk_id})` : ''}`;
  out.push('# Auditoría de superficie', '');
  out.push(`- **Material:** \`${source.name}\` · ${source.bytes} bytes · SHA-256 \`${source.sha256}\` · ${source.lines} líneas.`);
  const contracts = [...new Set(built.contracts)].sort();
  out.push(`- **Contrato en los recibos:** ${contracts.length ? contracts.join(', ') : 'no consta'}.`);
  out.push(`- **Comprobador:** dossier-check ${r.checker.version}, auditor ${AUDITOR_VERSION}.`);
  out.push(`- **Veredicto:** \`${r.verdict}\`: ${r.meaning}. Una superficie sin registro externo de cierre no pasa de \`inconclusive\`: el archivo lo hizo el modelo.`, '');

  // G1-G2 (38- §9, R1): cada estado del recibo por separado. Un `verified` no vale por la fidelidad de los
  // filtros, por la lista entera ni por la lectura; lo unsupported, parcial o pendiente se dice así.
  out.push('## G1–G2 · Ejecución y recuperación, por recibo (comprobado por código)', '');
  out.push('| Pasada | Consulta | Filtros declarados | Lista entregada |', '|---|---|---|---|');
  for (const p of r.passes ?? []) {
    const ps = [...p.attempts_valid, ...p.attempts_failed].map((ref) => payloads.get(ref) ?? null);
    const integrity = [...new Set(ps.map((x) => (!x ? 'ilegible' : typeof x.sent_query_sha256 !== 'string' ? 'fallida (error)' : x.status?.query_integrity ?? '¿?')))];
    const fidelity = [...new Set(ps.map((x) => x?.status?.filter_fidelity).filter(Boolean))];
    const valid = p.attempts_valid.map((ref) => payloads.get(ref)).filter(Boolean);
    const pending = [...new Set(valid.map((x) => x.next_retstart).filter((n) => Number.isSafeInteger(n) && !valid.some((y) => y.request?.retstart === n)))];
    const of = `${p.returned_size} de ${num(p.funnel.found)}`;
    const delivered = !valid.length ? 'no entra en los devueltos válidos'
      : valid.some((x) => x.records_complete === true) ? `entera (${of})`
        : p.union?.status === OPERATIONAL ? `${of}, ${p.union.label}`
          : `parcial: ${of}${pending.length ? `; quedan páginas desde ${pending.join(', ')}` : ''}`;
    out.push(`| ${passName(p)} | ${integrity.join(', ') || 'sin recibo'} | ${fidelity.length ? fidelity.join(', ') : 'sin filtros declarados'} | ${delivered} |`);
  }
  if (!(r.passes ?? []).length) out.push('| — | ninguna pasada atribuible | — | — |');
  const receipts = (tool) => (r.attempts ?? []).filter((a) => a.tool === tool).map((a) => {
    const x = payloads.get(a.attempt_ref);
    if (a.status !== 'ok') return `${a.attempt_ref}: ${a.kind === 'no_response' ? 'sin respuesta' : `no cuenta (${a.status})`}`;
    if (a.kind === 'fetch_rejected' || a.kind === 'summary_rejected') return `${a.attempt_ref}: rechazado antes de NCBI`;
    const errors = x.results.filter((y) => y?.record_status === 'error').length;
    return `${a.attempt_ref}: identidad ${x.status.record_identity}, entrega ${x.status.delivery}${x.pending_pmids.length ? `, ${x.pending_pmids.length} pendientes` : ''}${errors ? `, ${errors} con error` : ''}`;
  });
  out.push('', `- **Lecturas:** ${list(receipts('pubmed_fetch_exact'), 20)}.`, `- **Cribados:** ${list(receipts('pubmed_summary_exact'), 20)}.`);
  out.push(`- **Llamadas archivadas:** ${by('pubmed_search_exact')} búsquedas, ${by('pubmed_summary_exact')} cribados, ${by('pubmed_fetch_exact')} lecturas,`
    + ` ${built.contextCalls.length} de catálogo o filtro y ${by('other')} de otras herramientas.`);
  if (built.unreadable.length) out.push(`- **Líneas ilegibles:** ${built.unreadable.map((u) => `${u.line} (${u.reason})`).join(', ')}.`);
  const compared = built.responseOnly.length ? ` (${built.responseOnly.length} líneas traen solo la respuesta: herramienta deducida del recibo y petición sin comparar)` : '';
  const fieldsAt = (xs) => xs.map((m) => `${m.line} (${m.fields.join(', ')})`).join('; ');
  out.push(`- **Petición archivada frente a la acreditada por su recibo:** ${built.requestMismatches.length
    ? `distinta en las líneas ${fieldsAt(built.requestMismatches)}` : 'coinciden en todos los campos comparados'}${compared}.`
    + ' Se comparan consulta, tamaño pedido, desplazamiento, orden, filtros declarados y registro de selección en las búsquedas; PMID y contexto en lecturas y cribados.');
  if (built.requestUncomparable.length) out.push(`- **Campos archivados que el recibo no permite comparar:** líneas ${fieldsAt(built.requestUncomparable)}.`);
  const failed = r.exclusions.filter((x) => /integridad|búsqueda fallida/.test(x.reason));
  out.push(`- **Búsquedas excluidas por integridad:** ${failed.length ? failed.map((x) => `${x.attempt_ref} (${x.reason})`).join('; ') : 'ninguna'}.`);
  out.push(`- **Defectos del material:** ${r.defects.length ? '' : 'ninguno.'}`);
  for (const d of r.defects.slice(0, 30)) out.push(`  - \`${d.code}\`: ${d.detail}`);
  if (r.defects.length > 30) out.push(`  - y ${r.defects.length - 30} más en dossier-check.json`);
  if (r.defects.some((d) => d.code === 'abstract_gap' && /abstract_sha256 no coincide/.test(d.detail))) {
    out.push('', 'Una huella declarada que no coincide con el texto archivado suele indicar que la copia normalizó caracteres, al archivar o al exportar:'
      + ' espacios especiales, comillas o saltos de línea. Releer esos PMID distingue la normalización de una alteración del contenido.'
      + (online ? ' La relectura está en la sección «Con red».' : ' Con `--en-linea`, el auditor los relee.')
      + ' En cualquier caso, esos abstracts no cuentan como íntegros.');
  }
  const D = r.denominators ?? {};
  out.push(`- **PMID únicos devueltos (D2):** ${num(D.D2?.value)}, en ${num(D.D2?.raw_appearances)} apariciones.`);
  out.push(`- **Títulos cribados:** ${num(D.titles_screened?.value)}. No son lecturas. Fuera de toda lista: ${list(D.titles_screened?.outside_returned ?? [])}. Pendientes sin resolver: ${list(D.titles_screened?.pending_unresolved ?? [])}.`);
  out.push(`- **Abstracts íntegros conservados (D3):** ${num(D.D3?.value)} de ${num(D.D3?.requested_unique)} PMID pedidos. Sin abstract: ${list(D.D3?.without_abstract ?? [])}.`
    + ' Cada abstract se ha comprobado contra su huella y su forma canónica.');
  out.push('');

  out.push('## Catálogo archivado', '');
  if (!catalogs.length) out.push('- Ninguna llamada a `pubmed_filter_catalog` archivada.');
  for (const c of catalogs) {
    const what = c.status === 'identical' ? `idéntico al que construye este commit (contrato ${c.archived_version})`
      : c.status === 'different' ? `distinto del que construye este commit en ${list(c.keys, 12)}`
        : c.status === 'other_version' ? `de otra versión (archivado ${num(c.archived_version)}, este commit ${num(c.expected_version)}): no se compara`
          : `sin comparar: ${c.reason}`;
    out.push(`- **Línea ${c.line}:** ${what}; ${CATALOG_TEXT[c.text]}.`);
  }
  out.push('', 'Dice si lo archivado es lo que sirve este commit para los mismos argumentos; no que el modelo lo leyera.', '');

  out.push('## Embudo por pasada (medido sobre lo conservado)', '');
  out.push('| Pasada | Encontrados | Devueltos | Cribados | Leídos | Usados |', '|---|---:|---:|---:|---:|---:|');
  for (const p of r.passes ?? []) {
    const f = p.funnel;
    const failedOnly = p.attempts_valid.length === 0 && p.attempts_failed.length > 0;
    out.push(`| ${passName(p)}${failedOnly ? ' (fallida)' : ''} | ${num(f.found)} | ${f.returned} | ${f.screened} | ${f.abstracts_obtained} | ${num(f.used)} |`);
  }
  out.push('', 'Encontrados es el recuento de PubMed para la pasada. Los demás números son PMID de su lista devuelta. «Usados» exige citas resueltas o un registro de uso: sin él, no se mide.', '');

  out.push('## Procedencia: de identificado a leído', '');
  out.push(`- **Leídos sin pasada de origen ni declaración en \`known_pmids\`:** ${list(findingsOf('read_without_origin'))}.`);
  out.push(`- **Cribados sin pasada de origen:** ${list(findingsOf('screened_without_origin'))}.`);
  out.push(`- **Mencionados en la respuesta sin abstract conservado:** ${r.dossier && built.hasResponse ? list(findingsOf('mentioned_without_reading')) : 'sin respuesta aportada'}.`);
  out.push('', 'Un PMID leído sin procedencia puede venir de la web, de una búsqueda no archivada o del conocimiento del modelo: el material no permite saber cuál.', '');

  out.push('## Propósito declarado (declaración del agente)', '');
  if (!(r.purposes ?? []).length) out.push('- Ninguna búsqueda atribuible a un plan.');
  for (const p of r.purposes ?? []) {
    if (!p.first) { out.push(`- **${p.plan_ref}:** no declarado en ninguna de sus ${p.searches} búsquedas. Un propósito ausente no es orientación.`); continue; }
    const at = (x) => `${x.attempt_ref}${x.pass_id ? ` (${x.pass_id})` : ''}`;
    const parts = [`primero \`${p.first.purpose}\` en ${at(p.first)}${p.first.late ? ', **tardío**: declarado después de la primera búsqueda del plan, no muestra que rigiera antes' : ''}`];
    for (const c of p.changes) parts.push(`cambia en ${at(c)} de \`${c.from}\` a \`${c.to}\` ${c.reason ? `con motivo «${c.reason}»` : '**sin motivo**'}`);
    if (p.omitted_after_declared.length) parts.push(`lo omiten después: ${p.omitted_after_declared.map(at).join(', ')}`);
    out.push(`- **${p.plan_ref}** (orden: ${PURPOSE_ORDER[p.order_by]}): ${parts.join('; ')}.`);
  }
  out.push('', 'El propósito fija cuánta búsqueda basta (saturation_policy.sufficiency_by_purpose). Se ordena y se compara; que rigiera es una declaración.', '');

  // G3 y G4 por separado y G4 por etapa (38- §9, R1): una perla dentro del conjunto no dice nada de la lista
  // entregada, del cribado ni de lo leído.
  const measuredRetention = r.retention?.status === 'measured';
  const within = measuredRetention && Array.isArray(r.retention.within_query) ? r.retention.within_query : [];
  out.push('## G3 · Estrategia: lo medido y lo declarado', '');
  if (!measuredRetention) out.push('- **Medido:** nada; sin perlas, G3 no se mide.');
  else if (within.length) for (const w of within) out.push(`- **Medido, dentro del conjunto de ${w.pass_id}:** ${w.numerator} de ${w.denominator}: ${list(w.hits)} (${w.via}).`);
  else out.push('- **Medido:** no; ninguna pasada tiene recuperación completa ni intersección conservada. Una perla que falta puede estar fuera de la cabecera traída o fuera de la estrategia.');
  out.push('- **Declarado, no comprobado:** la pertinencia, la fuente y la independencia de cada perla. Aquí las aporta quien audita (`--perlas`), no el material del modelo.');
  out.push('- Una prueba de pocas perlas no acredita que la estrategia sea buena.', '');

  out.push('## G4 · Perlas por etapa', '');
  if (measuredRetention) {
    const st = (name) => r.retention.stages.find((s) => s.stage === name);
    const target = [...st('returned').hits, ...st('returned').missing];
    const inQuery = new Set(within.flatMap((w) => w.hits));
    const unmeasured = (r.passes ?? []).filter((p) => !within.some((w) => passKey(w) === passKey(p))).map((p) => p.pass_id ?? '¿?');
    const query = within.length ? { numerator: inQuery.size, denominator: target.length, missing: target.filter((p) => !inQuery.has(p)),
      note: unmeasured.length ? ` (sin medir: ${unmeasured.join(', ')})` : '' } : { status: 'not_measured' };
    out.push('| Etapa | Perlas | Faltan |', '|---|---|---|');
    for (const [label, s] of [['En el conjunto de la consulta', query], ['En la lista entregada', st('returned')], ['Entre los títulos cribados', st('titles_screened')],
      ['Con abstract conservado', st('abstracts_preserved')], ['Con uso documentado', st('documented_use')]]) {
      out.push(s.status === 'not_measured' ? `| ${label} | no comprobada | — |` : `| ${label} | ${s.numerator} de ${s.denominator}${s.note ?? ''} | ${list(s.missing)} |`);
    }
    const sp = online?.perlas;
    if (sp?.status === 'not_measured') {
      out.push('', `- **Dentro de algún conjunto:** no medido; no hay ninguna intersección válida (sin medir: ${list(sp.passes_not_measured)}). No se puede decir si las perlas que faltan estaban fuera de la cabecera o fuera de la estrategia.`);
    } else if (sp) {
      out.push('', `- **No devueltas, pero en algún conjunto:** ${list(sp.outside_head)}. La estrategia las alcanzaba; se quedaron fuera de la cabecera traída.`);
      out.push(`- **No devueltas y en ningún conjunto${sp.status === 'measured' ? '' : ' de los medidos'}:** ${list(sp.outside_sets)}.`
        + (sp.status === 'measured' ? ' Fuera de la estrategia.' : ` Sin medir: ${sp.passes_not_measured.join(', ')}, así que pudieron estar en alguno de esos.`));
    }
    out.push('', 'Cada etapa dice solo lo que mide; sin medida, queda no comprobada. G3 y G4 no reciben un veredicto conjunto.', '');
  } else if (built.referenceError) out.push(`- ${built.referenceError}.`, '');
  else out.push('- Sin perlas: ninguna etapa comprobada.', '');

  if (online) {
    out.push('## Con red (`--en-linea`)', '', 'Llamadas del auditor a NCBI, no del modelo: no cambian el material ni suman lecturas. Miden el conjunto de hoy, no el de la búsqueda.', '');
    if (online.passes.length) {
      out.push('| Pasada | Recuento en el recibo | Recuento hoy | Intersección |', '|---|---:|---:|---|');
      for (const p of online.passes) {
        out.push(`| ${p.pass_id}${p.walk_id ? ` (${p.walk_id})` : ''} | ${num(p.count_receipt)} | ${num(p.count_today)} | ${p.intersection ?? 'no medida'} |`);
      }
      const ids = (st) => online.passes.filter((p) => p.count_status === st).map((p) => p.pass_id);
      const [changedIds, unknownIds] = [ids('changed'), ids('not_compared')];
      const lines = [];
      if (changedIds.length) lines.push(`El recuento ha cambiado en ${changedIds.join(', ')}. Ahí, una perla dentro del conjunto de hoy pudo no estar en el de la búsqueda, o al revés.`);
      if (unknownIds.length) lines.push(`No se pudo comparar el recuento en ${unknownIds.join(', ')}: no se sabe si su conjunto de hoy es el de la búsqueda.`);
      if (!lines.length) lines.push('Los recuentos de hoy son los del recibo en todas las pasadas comparadas.');
      out.push('', ...lines, '');
    } else if (!r.retention || r.retention.status !== 'measured') out.push('- **Perlas dentro del conjunto:** sin perlas, no se lanzan intersecciones.', '');
    const by = (o) => online.rereads.filter((x) => x.outcome === o);
    if (online.rereads.length) {
      out.push(`- **Relectura de huellas que no cuadran:** ${online.rereads.length} abstracts.`);
      for (const [o, label] of [['normalized', 'Normalizados en la copia, mismo contenido'], ['altered', 'Alterados'],
        ['hash_differs_today', 'Con otra huella hoy, sin decidir'], ['not_reread', 'Sin relectura']]) {
        const xs = by(o);
        if (!xs.length) continue;
        const why = o === 'normalized' ? ` Espacios especiales cambiados por espacios normales: ${[...new Set(xs.flatMap((x) => x.code_points))].sort().join(', ')}.` : '';
        out.push(`  - ${label}: ${xs.length} (${xs.map((x) => (o === 'normalized' ? x.pmid : `${x.pmid}: ${x.detail}`)).join('; ')}).${why}`);
      }
    } else out.push('- **Relectura de huellas que no cuadran:** no hay ninguna.');
    if (online.failures.length) out.push(`- **No medido por fallo:** ${online.failures.join('; ')}.`);
    out.push('');
  }

  out.push('## Enlaces a PubMed en la respuesta', '');
  if (r.links?.status === 'measured') {
    const bad = r.links.with_parameters;
    out.push(`- **Canónicos:** ${r.links.canonical}. **Con consulta o fragmento:** ${bad.length ? list(bad.map((l) => `${l.pmid} (\`${l.text}\`)`), 20) : 'ninguno'}.`);
    out.push('', 'La cita canónica es https://pubmed.ncbi.nlm.nih.gov/<PMID>/, sin parámetros de seguimiento (provenance.citation_form).', '');
  } else out.push('- Sin respuesta aportada.', '');

  out.push('## Lo que este informe no acredita', '');
  out.push('- **G1–G2:** que el archivo tenga todas las llamadas. Sin registro externo de cierre, lo conservado es lo que el modelo archivó.');
  out.push('- **G3:** la calidad de la estrategia. Se mide qué perlas contiene cada conjunto; su pertinencia, su fuente y su independencia son declaradas, y unas pocas perlas no acreditan una estrategia.');
  out.push('- **G4:** nada fuera de la etapa que mide. Una perla dentro del conjunto no está por eso en la lista entregada, en el cribado ni en lo leído, y G3 y G4 no reciben un veredicto conjunto.');
  out.push('- **G5–G6:** la validez de la síntesis y su aplicabilidad. Ninguna herramienta las comprueba, ni la comprensión ni la suficiencia clínica.');
  out.push('- El propósito, el registro de selección y lo apartado en el cribado son declaraciones del agente: se ordenan y se comparan, no se acreditan.');
  out.push('- El catálogo se compara con el que construye este commit: no prueba que el modelo lo leyera ni que siguiera su guía.');
  for (const l of LIMITS) out.push(`- ${l}`);
  out.push('');
  if (r.uncertainties.length || r.notices.length) {
    out.push('## Incertidumbres y avisos', '');
    for (const u of r.uncertainties) out.push(`- \`${u.code}\`: ${u.detail}`);
    for (const n of r.notices.slice(0, 20)) out.push(`- ${n}`);
    if (r.notices.length > 20) out.push(`- y ${r.notices.length - 20} avisos más en dossier-check.json`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * Todo el recorrido en memoria: dossier, comprobación e informe. Con `online` (las funciones de
 * `onlineChecks`), las comprobaciones con red y una segunda pasada del comprobador con las intersecciones.
 * Con `catalog` (la construcción de referencia de `compareCatalogs`), la comparación de cada catálogo
 * archivado; sin ella, quedan sin comparar.
 */
export async function auditSurface(jsonlText, { responseBytes = null, perlas = null, name = 'recibos.jsonl', online: net = null, catalog = null } = {}) {
  const built = await buildSurfaceDossier(jsonlText, { responseBytes, perlas });
  const load = async (p) => (safePath(p) ? built.files.get(p) ?? null : null);
  let result = await checkDossier(built.manifest, load);
  let online = null;
  if (net) {
    online = await onlineChecks(built, result, net);
    if (built.manifest.intersections?.length) {
      // Las intersecciones son material del auditor: solo pueden añadir la medida dentro del conjunto. Si la
      // segunda comprobación cambia el veredicto, los defectos o las incertidumbres del material del modelo
      // (un rechazo, una excepción del comprobador, lo que sea), se retiran todas, se guardan como evidencia
      // propia y se conserva entera la comprobación base (revisión de Codex del auditor, R1).
      const second = await checkDossier(built.manifest, load);
      const changed = [
        second.verdict !== result.verdict && `veredicto ${result.verdict} → ${second.verdict}`,
        !same(second.defects, result.defects) && `defectos ${result.defects.length} → ${second.defects.length}`,
        !same(second.uncertainties, result.uncertainties) && `incertidumbres ${result.uncertainties.length} → ${second.uncertainties.length}`,
      ].filter(Boolean);
      if (changed.length) {
        const reasons = [...second.defects.filter((d) => d.code === 'intersection'), ...second.uncertainties.filter((u) => u.code === 'checker_exception')]
          .map((d) => d.detail.slice(0, 200));
        online.failures.push(`intersecciones descartadas: cambiaban la comprobación del material (${changed.join('; ')})${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
        for (const [k, x] of built.manifest.intersections.entries()) {
          online.files.set(`en-linea/interseccion-rechazada-${String(k + 1).padStart(3, '0')}.json`, built.files.get(x.file));
          built.files.delete(x.file);
        }
        built.manifest.intersections = [];
        for (const p of online.passes) p.intersection = null;
      } else result = second;
    }
    if (result.retention?.status === 'measured') splitPerlas(result, online);
  }
  const contracts = [];
  for (const [path, bytes] of built.files) {
    if (!path.startsWith('intentos/')) continue;
    const p = payloadOf(JSON.parse(new TextDecoder().decode(bytes)));
    if (typeof p?.run?.contract_version === 'string') contracts.push(p.run.contract_version);
  }
  const bytes = enc(jsonlText);
  const source = { name, bytes: bytes.length, sha256: await sha256Bytes(bytes), lines: jsonlText.split(/\r?\n/).filter((l) => l.trim()).length };
  const catalogs = await compareCatalogs(built.contextCalls, catalog);
  const report = renderReport(result, { source, built: { ...built, contracts, hasResponse: Boolean(responseBytes) }, online, catalogs });
  return { built, result, report, online, catalogs };
}

/** Las funciones de red de `onlineChecks` con los ejecutores del repo: búsqueda y lectura con su recibo. */
export function ncbiOnline({ run = null, apiKey = '', email = '', fetcher, spacingMs = apiKey ? 110 : 350 } = {}) {
  const engine = 'scripts/audit-surface.mjs';
  return {
    search: async (term, retmax) => ({ run, ...await runExact(term, { retmax, apiKey, email, fetcher, engine }) }),
    read: (pmid, n) => runFetch([pmid], { plan_ref: 'auditoria-superficie', read_id: `relectura-${n}` }, { run, apiKey, email, fetcher, engine }),
    pause: () => new Promise((r) => setTimeout(r, spacingMs)),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const file = args.find((a, i) => !a.startsWith('--') && !['--respuesta', '--perlas', '--salida'].includes(args[i - 1]));
  if (!file) {
    console.error('Uso: node scripts/audit-surface.mjs recibos.jsonl [--respuesta respuesta.md] [--perlas perlas.json] [--salida carpeta] [--en-linea]');
    process.exit(2);
  }
  let jsonlText;
  let responseBytes = null;
  let perlas = null;
  try {
    jsonlText = readFileSync(file, 'utf8');
    if (opt('--respuesta')) responseBytes = new Uint8Array(readFileSync(opt('--respuesta')));
    if (opt('--perlas')) perlas = JSON.parse(readFileSync(opt('--perlas'), 'utf8'));
  } catch (e) {
    console.error(`No se puede leer la entrada: ${e.message}`);
    process.exit(2);
  }
  const net = args.includes('--en-linea')
    ? ncbiOnline({ run: await runContext(), apiKey: process.env.NCBI_API_KEY ?? '', email: process.env.NCBI_EMAIL ?? '' }) : null;
  const { built, result, report, online, catalogs } = await auditSurface(jsonlText, { responseBytes, perlas, name: basename(file), online: net,
    catalog: await repoCatalog() });
  const out = resolve(opt('--salida') ?? join(dirname(resolve(file)), `${basename(file).replace(/\.jsonl$/i, '')}.auditoria`));
  mkdirSync(out, { recursive: true });
  for (const [p, bytes] of [...built.files, ...(online?.files ?? [])]) {
    const target = join(out, ...p.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(join(out, 'manifiesto.json'), `${JSON.stringify(built.manifest, null, 2)}\n`);
  writeFileSync(join(out, 'dossier-check.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(out, 'catalogo.json'), `${JSON.stringify(catalogs, null, 2)}\n`);
  writeFileSync(join(out, 'informe.md'), `${report}\n`);
  if (online) {
    const { files: _f, ...summary } = online;
    writeFileSync(join(out, 'en-linea.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
  console.log(`${result.verdict} · ${result.defects.length} defectos · ${result.findings.length} hallazgos · ${out}`);
  process.exitCode = result.exit_code;
}
