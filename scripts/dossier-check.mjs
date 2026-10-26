#!/usr/bin/env node
/**
 * Comprueba un dossier de búsqueda y lectura (especificación 29-, §4, con la adenda de Codex del 24/10).
 *
 *   node scripts/dossier-check.mjs ruta/al/manifiesto.json
 *
 * Imprime un JSON determinista y sale 0 si el dossier es `consistent`, 1 si es `incomplete` y 2 si es
 * `inconclusive`. Hermano de `page-union.mjs`, y como él vive FUERA del servidor: local, sin red. Lee
 * archivos; no los modifica, no rehace búsquedas, no rellena pérdidas y no interpreta clínicamente.
 *
 * QUÉ ACREDITA. Que el material recibido es coherente consigo mismo y con la procedencia declarada:
 * huellas, recibos, particiones, abstracts íntegros en su representación canónica, anclas de uso en la
 * respuesta conservada, y los cuatro denominadores medidos sobre lo conservado (D1 encontrados por
 * pasada, D2 PMID únicos devueltos, D3 abstracts obtenidos y conservados, D4 documentos usados).
 *
 * QUÉ NO, y no puede. Que se atendiera o se entendiera lo leído, que una fuente sostenga lo que se dice
 * de ella, que una búsqueda causara una selección, ni que no se omitieran llamadas cuando la captura no
 * prueba su cierre. `consistent` solo certifica consistencia del material bajo la procedencia declarada.
 * El cierre lo prueba la captura, no la etiqueta `bench` o `surface`. Una mención de un PMID no suma D4
 * sin cita resuelta o registro de uso. Sin cota de reloj justificada, el orden es `unknown`.
 *
 * FORMATOS (todos con `format` y `format_version: 1`; se documentan en README.md):
 *   pubmed-dossier-manifest     el manifiesto: una ejecución, su inventario de intentos y sus archivos
 *   pubmed-dossier-capture-log  la evidencia externa de cierre: las llamadas que registró la captura
 *   pubmed-dossier-uses         citas nativas resueltas o registro lateral de uso, atados a la respuesta
 *   pubmed-dossier-reference    la referencia de retención (también vale un caso de scripts/eval/cases.json)
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, continuation, ESEARCH_WINDOW } from './exact-core.mjs';
import { checkPageUnion, OPERATIONAL, OPERATIONAL_LABEL } from './page-union.mjs';
import { sha256Bytes, FETCH_RECEIPT_TYPE, FETCH_RECEIPT_VERSION, RECORD_STATUSES, PMID_PATTERN } from './fetch-core.mjs';
import { ABSTRACT_FORMAT, checkCanonicalAbstract, utf8Length } from './abstract-canonical.mjs';

export const CHECKER_VERSION = '1.0.0';
export const FORMATS = {
  manifest: 'pubmed-dossier-manifest',
  capture_log: 'pubmed-dossier-capture-log',
  uses: 'pubmed-dossier-uses',
  reference: 'pubmed-dossier-reference',
};
export const VERDICTS = { consistent: 0, incomplete: 1, inconclusive: 2 };
export const LIMITS = [
  'Acredita consistencia del material recibido bajo la procedencia declarada; no que se leyera, se entendiera ni se trasladara.',
  'unattributed significa sin procedencia declarada acreditable en el dossier, no prueba de memoria del modelo.',
  'La pertenencia a una lista no prueba que esa búsqueda causara la selección.',
  'D4 acredita uso documental visible, no que la fuente sostenga la afirmación.',
  'Las huellas y run identifican, no autentican: no son firmas de NCBI ni del servidor.',
  'Una unión de páginas es una recuperación operativa sin instantánea fijada, nunca un conjunto completo certificado.',
];

const TOOLS = ['pubmed_search_exact', 'pubmed_fetch_exact', 'other'];
const SHA = /^[0-9a-f]{64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const optStr = (v) => v === undefined || v === null || isStr(v);
const byPmid = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
const sortPmids = (iter) => [...new Set(iter)].sort(byPmid);
const tuple = (...parts) => JSON.stringify(parts);
const extraKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));

/** Ruta relativa al manifiesto, sin salir de su carpeta ni apuntar a otra unidad. */
export const safePath = (p) => isStr(p) && !/^[A-Za-z]:|^[\\/]|\\/.test(p) && !p.split('/').some((s) => s === '..' || s === '');

// --- Manifiesto -----------------------------------------------------------------------------------

const fileRef = (v, at, extra = []) => {
  if (!isObj(v)) return `${at} debe ser un objeto { file, sha256 }`;
  const bad = extraKeys(v, ['file', 'sha256', ...extra]);
  if (bad.length) return `${at}: claves no admitidas ${bad.join(', ')}`;
  if (!safePath(v.file)) return `${at}.file debe ser una ruta relativa dentro de la carpeta del manifiesto`;
  if (typeof v.sha256 !== 'string' || !SHA.test(v.sha256)) return `${at}.sha256 debe ser un SHA-256 en hexadecimal`;
  return null;
};

/** Forma del manifiesto. Devuelve la lista de errores; vacía si se puede leer. */
export function manifestErrors(m) {
  if (!isObj(m)) return ['el manifiesto no es un objeto'];
  const errors = [];
  const bad = extraKeys(m, ['format', 'format_version', 'dossier_id', 'case', 'condition', 'profile', 'capture', 'plans',
    'attempts', 'response', 'citations', 'usage_log', 'reference', 'intersections']);
  if (bad.length) errors.push(`claves no admitidas: ${bad.join(', ')}`);
  if (m.format !== FORMATS.manifest || m.format_version !== 1) errors.push(`format debe ser ${FORMATS.manifest}, versión 1`);
  if (!isStr(m.dossier_id)) errors.push('dossier_id: identificador único de la ejecución');
  if (!optStr(m.case) || !optStr(m.condition)) errors.push('case y condition son cadenas o null');
  if (!['bench', 'surface'].includes(m.profile)) errors.push('profile: bench o surface');
  const c = m.capture;
  if (!isObj(c)) errors.push('capture: { method, inventory_by, closure, clock }');
  else {
    const cb = extraKeys(c, ['method', 'inventory_by', 'closure', 'clock']);
    if (cb.length) errors.push(`capture: claves no admitidas ${cb.join(', ')}`);
    if (!isStr(c.method)) errors.push('capture.method: cómo se capturó (p. ej. harness_log, chatgpt_export)');
    if (!['harness', 'human', 'model'].includes(c.inventory_by)) errors.push('capture.inventory_by: harness, human o model');
    if (c.closure !== undefined && c.closure !== null) { const e = fileRef(c.closure, 'capture.closure'); if (e) errors.push(e); }
    if (c.clock !== undefined && c.clock !== null) {
      if (!isObj(c.clock) || extraKeys(c.clock, ['skew_bound_ms', 'justification']).length
        || !Number.isFinite(c.clock.skew_bound_ms) || c.clock.skew_bound_ms < 0 || !isStr(c.clock.justification)) {
        errors.push('capture.clock: { skew_bound_ms ≥ 0, justification } o null');
      }
    }
  }
  if (!Array.isArray(m.plans) || m.plans.length === 0) errors.push('plans: lista no vacía de { plan_ref, passes }');
  else {
    m.plans.forEach((p, i) => {
      if (!isObj(p) || extraKeys(p, ['plan_ref', 'passes']).length || !isStr(p.plan_ref)
        || !Array.isArray(p.passes) || !p.passes.every(isStr)) errors.push(`plans[${i}]: { plan_ref, passes: [pass_id] }`);
    });
    const refs = m.plans.map((p) => p?.plan_ref);
    if (new Set(refs).size !== refs.length) errors.push('plans: plan_ref repetido');
  }
  if (!Array.isArray(m.attempts)) errors.push('attempts: lista de intentos (puede ser vacía)');
  else {
    m.attempts.forEach((a, i) => {
      const at = `attempts[${i}]`;
      if (!isObj(a)) { errors.push(`${at} debe ser un objeto`); return; }
      const ab = extraKeys(a, ['attempt_ref', 'tool', 'external_id', 'file', 'sha256', 'captured', 'absent_reason',
        'plan_ref', 'pass_id', 'walk_id', 'note', 'request']);
      if (ab.length) errors.push(`${at}: claves no admitidas ${ab.join(', ')}`);
      // La petición conservada de una lectura sin respuesta (R3): qué PMID quedaron sin leer.
      if (a.request !== undefined && a.request !== null) {
        const pm = a.request?.pmids;
        if (a.tool !== 'pubmed_fetch_exact' || (a.file !== undefined && a.file !== null) || !isObj(a.request)
          || extraKeys(a.request, ['pmids']).length || !Array.isArray(pm) || pm.length < 1 || pm.length > 5
          || !pm.every((p) => typeof p === 'string' && PMID_PATTERN.test(p)) || new Set(pm).size !== pm.length) {
          errors.push(`${at}.request: solo en una lectura sin respuesta, { pmids: 1-5 PMID sin repetir }`);
        }
      }
      if (!isStr(a.attempt_ref)) errors.push(`${at}.attempt_ref obligatorio`);
      if (!TOOLS.includes(a.tool)) errors.push(`${at}.tool: ${TOOLS.join(', ')}`);
      if (!optStr(a.external_id) || !optStr(a.plan_ref) || !optStr(a.pass_id) || !optStr(a.walk_id) || !optStr(a.note)) {
        errors.push(`${at}: external_id, plan_ref, pass_id, walk_id y note son cadenas o null`);
      }
      const hasFile = a.file !== undefined && a.file !== null;
      if (hasFile) {
        const e = fileRef({ file: a.file, sha256: a.sha256 }, at);
        if (e) errors.push(e);
        if (!['on_receipt', 'transcribed'].includes(a.captured)) errors.push(`${at}.captured: on_receipt o transcribed`);
        if (a.absent_reason !== undefined && a.absent_reason !== null) errors.push(`${at}: un intento con archivo no lleva absent_reason`);
      } else if (!isStr(a.absent_reason)) {
        errors.push(`${at}: sin archivo, absent_reason dice por qué no hay respuesta`);
      }
    });
    const refs = m.attempts.map((a) => a?.attempt_ref);
    if (new Set(refs).size !== refs.length) errors.push('attempts: attempt_ref repetido');
  }
  for (const k of ['citations', 'usage_log']) {
    if (m[k] !== undefined && m[k] !== null) { const e = fileRef(m[k], k); if (e) errors.push(e); }
  }
  if (m.response !== undefined && m.response !== null) {
    const e = fileRef(m.response, 'response', ['captured']);
    if (e) errors.push(e);
    else if (!['on_receipt', 'transcribed'].includes(m.response.captured)) errors.push('response.captured: on_receipt o transcribed');
  }
  if (m.reference !== undefined && m.reference !== null) {
    const e = fileRef(m.reference, 'reference', ['case_id']);
    if (e) errors.push(e);
    else if (!optStr(m.reference.case_id)) errors.push('reference.case_id es una cadena o null');
  }
  if (m.intersections !== undefined) {
    if (!Array.isArray(m.intersections)) errors.push('intersections: lista');
    else {
      m.intersections.forEach((x, i) => {
        const e = fileRef(x, `intersections[${i}]`, ['plan_ref', 'pass_id', 'walk_id']);
        if (e) errors.push(e);
        else if (!isStr(x.plan_ref) || !isStr(x.pass_id) || !optStr(x.walk_id)) errors.push(`intersections[${i}]: plan_ref y pass_id de la pasada original`);
      });
    }
  }
  return errors;
}

// --- Recibos ----------------------------------------------------------------------------------------

/** Envoltura nativa (result.structuredContent) o copia íntegra; si trae texto, debe decir lo mismo. */
function unwrap(json) {
  const holder = isObj(json?.result) && 'structuredContent' in json.result ? json.result
    : isObj(json) && 'structuredContent' in json ? json : null;
  if (!holder) return { payload: json, textMismatch: false };
  const text = holder.content?.find?.((c) => c?.type === 'text')?.text;
  let textMismatch = false;
  if (typeof text === 'string') {
    try { textMismatch = JSON.stringify(JSON.parse(text)) !== JSON.stringify(holder.structuredContent); } catch { textMismatch = true; }
  }
  return { payload: holder.structuredContent, textMismatch };
}

function kindOf(p) {
  if (!isObj(p)) return 'unknown';
  if (p.receipt_type === FETCH_RECEIPT_TYPE) {
    if (p.receipt_version !== FETCH_RECEIPT_VERSION) return 'unknown';
    return p.rejected_before_ncbi === true ? 'fetch_rejected' : 'fetch';
  }
  if (typeof p.sent_query_sha256 === 'string' && isObj(p.status) && 'query_integrity' in p.status) return 'search';
  if (typeof p.error === 'string' && p.result_count === null) return 'search_error';
  return 'unknown';
}

const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isInt = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const isSha = (v) => typeof v === 'string' && SHA.test(v);
const strOrNull = (v) => v === null || typeof v === 'string';
const pmidList = (l, pattern) => Array.isArray(l) && l.every((p) => typeof p === 'string' && pattern.test(p));

/**
 * Forma de un recibo de búsqueda 1.13 o posterior (revisión de Codex, R1). Se comprueba ANTES de usar
 * ningún campo: lo que no tiene la forma no se interpreta y queda como entrada no soportada, nunca como
 * excepción ni como aprobado.
 */
function searchShapeErrors(r) {
  const e = [];
  if (!('run' in r) || !(r.run === null || isObj(r.run))) e.push('run');
  if (!isIso(r.executed_at)) e.push('executed_at');
  for (const k of ['engine', 'endpoint', 'sent_query', 'transport']) if (typeof r[k] !== 'string') e.push(k);
  for (const k of ['sent_query_sha256', 'pmid_list_sha256', 'raw_response_sha256']) if (!isSha(r[k])) e.push(k);
  const q = r.request;
  if (!isObj(q) || !isInt(q.retstart) || !isInt(q.retmax_requested) || !isInt(q.retmax_sent) || !strOrNull(q.sort)) e.push('request');
  if (!(r.result_count === null || isInt(r.result_count)) || !strOrNull(r.count_raw)) e.push('result_count/count_raw');
  if (!isInt(r.records_retrieved) || typeof r.records_complete !== 'boolean') e.push('records_retrieved/records_complete');
  if (!(r.page === null || (isObj(r.page) && isInt(r.page.first, 1) && isInt(r.page.last, 1)))) e.push('page');
  if (!(r.next_retstart === null || isInt(r.next_retstart)) || !strOrNull(r.next_retstart_reason)) e.push('next_retstart');
  if (!pmidList(r.pmids, /^[0-9]{1,9}$/)) e.push('pmids');
  if (!Array.isArray(r.pagination_notices) || !r.pagination_notices.every((x) => typeof x === 'string')) e.push('pagination_notices');
  if (!isObj(r.status) || !['verified', 'failed', 'unsupported'].includes(r.status.query_integrity)) e.push('status.query_integrity');
  if (!Array.isArray(r.problems)) e.push('problems');
  const sr = r.selection_record;
  if (sr !== undefined) {
    const rec = sr?.record;
    const known = rec?.known_pmids;
    if (!isObj(sr) || sr.declared_by !== 'agent' || !isIso(sr.received_at) || typeof sr.sha256 !== 'string' || !isObj(rec)
      || !(rec.plan_ref === undefined || isStr(rec.plan_ref)) || !isObj(rec.pass) || !isStr(rec.pass.pass_id)
      || !(rec.pass.reading_path === undefined || typeof rec.pass.reading_path === 'string')
      || !(known === undefined || (Array.isArray(known) && known.every((k) => isObj(k) && typeof k.pmid === 'string'
        && /^[0-9]{1,9}$/.test(k.pmid) && isStr(k.origin) && (k.detail === undefined || typeof k.detail === 'string'))))) {
      e.push('selection_record');
    }
  }
  return e;
}

/**
 * Coherencia interna de un recibo de búsqueda con forma válida (§4.2 y R1): huellas recalculadas y las
 * relaciones entre recuento, lista, posición, tamaño, completitud y continuación, recalculadas con el
 * mismo criterio del ejecutor. No basta `verified`. Devuelve los defectos.
 */
async function searchDefects(r) {
  const d = [];
  if (await sha256(r.sent_query) !== r.sent_query_sha256) d.push('sent_query_sha256 no corresponde a sent_query');
  if (await sha256(r.pmids.join('\n')) !== r.pmid_list_sha256) d.push('pmid_list_sha256 no corresponde a la lista');
  if (r.selection_record !== undefined && await sha256(JSON.stringify(r.selection_record.record)) !== r.selection_record.sha256) {
    d.push('selection_record.sha256 no corresponde al registro');
  }
  const n = r.pmids.length;
  const start = r.request.retstart;
  const count = r.result_count;
  if (new Set(r.pmids).size !== n) d.push('PMID repetidos dentro de la página');
  if (r.records_retrieved !== n) d.push('records_retrieved no coincide con la lista');
  const pageOk = n === 0 ? r.page === null : r.page?.first === start + 1 && r.page?.last === start + n;
  if (!pageOk) d.push('page no corresponde a retstart y a la lista');
  if (count !== null && String(count) !== r.count_raw) d.push(`result_count (${count}) no corresponde a count_raw (${r.count_raw})`);
  // Una página vacía pedida tras el final (o tras encoger el conjunto) no devuelve nada fuera de posición (Δ2).
  if (count !== null && n > 0 && start + n > count) d.push(`la página llega más allá del recuento (${start} + ${n} > ${count})`);
  if (r.records_complete !== (start === 0 && count !== null && n === count)) d.push('records_complete no corresponde a recuento y lista');
  if (r.request.retmax_sent !== Math.min(r.request.retmax_requested, ESEARCH_WINDOW - start)) d.push('retmax_sent no corresponde a lo pedido');
  const next = continuation({ integrity: r.status.query_integrity, retstart: start, retmaxRequested: r.request.retmax_requested,
    retmaxSent: r.request.retmax_sent, count, n, notices: r.pagination_notices });
  if (next.next_retstart !== r.next_retstart || next.next_retstart_reason !== r.next_retstart_reason) {
    d.push(`continuación incoherente con la página: el ejecutor daría ${next.next_retstart}/${next.next_retstart_reason}`);
  }
  return d;
}

/** Forma de un resultado por PMID; null si es válida. */
function resultShapeError(x) {
  if (!isObj(x)) return 'no es un objeto';
  if (typeof x.requested_pmid !== 'string' || !PMID_PATTERN.test(x.requested_pmid)) return 'requested_pmid';
  if (!RECORD_STATUSES.includes(x.record_status)) return 'record_status';
  if (!strOrNull(x.returned_pmid) || !strOrNull(x.reason)) return 'returned_pmid o reason';
  if (x.record_status === 'with_abstract' || x.record_status === 'without_abstract') {
    if (!['PubmedArticle', 'PubmedBookArticle'].includes(x.record_type) || !strOrNull(x.title)
      || ![x.dois, x.pmcids, x.publication_types].every((l) => Array.isArray(l) && l.every((v) => typeof v === 'string'))
      || !(x.year === null || Number.isSafeInteger(x.year))) return 'identidad del registro';
  }
  if (x.record_status === 'without_abstract'
    && [x.abstract_format, x.abstract_bytes, x.abstract_sha256, x.abstract_canonical].some((v) => v !== null)) return 'without_abstract con abstract';
  return null;
}

/** Forma de un recibo de lectura (R1): sin run, intento, tiempos, transporte o límites no es este formato. */
function fetchShapeErrors(r) {
  const e = [];
  if (!isObj(r.run)) e.push('run');
  if (!isStr(r.attempt_id)) e.push('attempt_id');
  if (!isIso(r.received_at) || !(r.executed_at === null || isIso(r.executed_at)) || !isIso(r.completed_at)) e.push('tiempos');
  for (const k of ['engine', 'provider', 'endpoint']) if (!isStr(r[k])) e.push(k);
  const q = r.request;
  if (!isObj(q) || !pmidList(q.pmids, PMID_PATTERN) || q.pmids.length === 0 || new Set(q.pmids).size !== q.pmids.length
    || !isObj(q.context) || !isStr(q.context.plan_ref) || !isStr(q.context.read_id) || typeof q.context_sha256 !== 'string'
    || q.declared_by !== 'agent' || typeof q.api_key_used !== 'boolean' || typeof q.email_used !== 'boolean') e.push('request');
  const t = r.transport;
  if (!isObj(t) || !isStr(t.method) || !(t.http_status === null || isInt(t.http_status)) || !(t.bytes_received === null || isInt(t.bytes_received))
    || !(t.raw_response_sha256 === null || isSha(t.raw_response_sha256))) e.push('transport');
  if (!isObj(r.limits) || !isInt(r.limits.max_pmids, 1) || !isInt(r.limits.structured_content_max_bytes, 1)) e.push('limits');
  if (!(r.failure === null || (isObj(r.failure) && isStr(r.failure.code) && typeof r.failure.message === 'string'))) e.push('failure');
  if (!isObj(r.status) || !['verified', 'failed', 'unsupported'].includes(r.status.record_identity)
    || !['complete', 'partial', 'failed'].includes(r.status.delivery)) e.push('status');
  if (!Array.isArray(r.problems) || !r.problems.every((v) => typeof v === 'string')) e.push('problems');
  if (!Array.isArray(r.pending_pmids) || !r.pending_pmids.every((x) => isObj(x) && typeof x.pmid === 'string' && isStr(x.reason))) e.push('pending_pmids');
  if (!Array.isArray(r.results)) e.push('results');
  else r.results.forEach((x, i) => { const bad = resultShapeError(x); if (bad) e.push(`results[${i}]: ${bad}`); });
  return e;
}

/**
 * Forma mínima del rechazo previo a NCBI (Δ3): la que produce mcp/protocol.mjs. No se le exige la envoltura
 * de una lectura ejecutada, pero sin run, intento, hora y motivo no es un rechazo reconocible.
 */
function rejectionShapeErrors(r) {
  const e = [];
  if (!isObj(r.run)) e.push('run');
  if (!isStr(r.attempt_id)) e.push('attempt_id');
  if (!isIso(r.received_at)) e.push('received_at');
  if (!isStr(r.error)) e.push('error');
  return e;
}

/**
 * Coherencia de un recibo de lectura con forma válida (§3.3, §3.6) y de cada abstract entregado. Separa
 * el texto íntegro del abstract ATRIBUIBLE (R2): un recibo con identidad o entrega fallidas, o con
 * contradicciones, no acredita ningún registro; un registro con otro returned_pmid, tampoco el suyo.
 * Devuelve los defectos, los PMID cuyo resultado es atribuible y los abstracts comprobados.
 */
async function fetchDefects(r) {
  const d = [];
  const pmids = r.request.pmids;
  const ctx = r.request.context;
  if (await sha256(JSON.stringify({ plan_ref: ctx.plan_ref, read_id: ctx.read_id })) !== r.request.context_sha256) {
    d.push('request.context o context_sha256 no corresponden');
  }
  const delivered = r.results.map((x) => x.requested_pmid);
  const pending = r.pending_pmids.map((x) => x.pmid);
  const all = [...delivered, ...pending];
  const inOrder = (list) => list.every((p, i) => i === 0 || pmids.indexOf(list[i - 1]) < pmids.indexOf(p));
  if (all.length !== pmids.length || new Set(all).size !== all.length || !all.every((p) => pmids.includes(p))
    || !inOrder(delivered) || !inOrder(pending)) {
    d.push('resultados y pendientes no son una partición ordenada de lo pedido');
  }
  const { record_identity: identity, delivery } = r.status;
  const errors = r.results.filter((x) => x.record_status === 'error');
  const found = r.results.filter((x) => x.record_status === 'with_abstract' || x.record_status === 'without_abstract');
  const times = [r.received_at, r.executed_at, r.completed_at].filter((t) => t !== null).map((t) => Date.parse(t));
  const contradictions = [
    delivery === 'complete' && (pending.length || errors.length) && 'complete con pendientes o errores',
    delivery === 'partial' && !pending.length && !errors.length && 'partial sin pendientes ni errores',
    delivery === 'failed' && (found.length || pending.length) && 'failed con registros entregados o pendientes',
    identity === 'failed' && delivery !== 'failed' && 'identidad failed con entrega no failed',
    (r.failure !== null) !== (delivery === 'failed') && 'failure y delivery no concuerdan',
    identity === 'verified' && r.results.some((x) => ['identity_uncertain', 'unsupported_record'].includes(x.reason))
      && 'identidad verified con registros de identidad incierta o no soportados',
    // Un abstract, su falta o la ausencia del registro solo los acredita una respuesta ejecutada, HTTP 200 y con
    // huella (revisión del delta, Δ1). Un fallo de transporte se representa como error, nunca como ausencia.
    r.results.some((x) => ['with_abstract', 'without_abstract', 'not_found'].includes(x.record_status))
      && (r.executed_at === null || r.transport.http_status !== 200 || r.transport.raw_response_sha256 === null)
      && 'registros o ausencias sin respuesta ejecutada, HTTP 200 y con huella',
    times.some((t, i) => i > 0 && t < times[i - 1]) && 'tiempos fuera de orden',
    pmids.length > r.limits.max_pmids && 'más PMID pedidos que el límite del recibo',
  ].filter(Boolean);
  for (const c of contradictions) d.push(`estados contradictorios: ${c}`);
  const receiptTrusted = d.length === 0 && identity !== 'failed' && delivery !== 'failed';
  const attributable = new Set();
  const abstracts = [];
  for (const x of r.results) {
    if (x.record_status === 'error' && !isStr(x.reason)) d.push(`PMID ${x.requested_pmid}: error sin reason`);
    const ownId = x.record_status === 'not_found' ? x.returned_pmid === null : x.returned_pmid === x.requested_pmid;
    if ((x.record_status === 'with_abstract' || x.record_status === 'without_abstract') && !ownId) {
      d.push(`PMID ${x.requested_pmid}: returned_pmid distinto (${x.returned_pmid})`);
    }
    if (receiptTrusted && ownId) attributable.add(x.requested_pmid);
    if (x.record_status !== 'with_abstract') continue;
    const problems = [];
    if (x.abstract_format !== ABSTRACT_FORMAT) problems.push(`formato ${x.abstract_format} no soportado`);
    const check = checkCanonicalAbstract(x.abstract_canonical);
    problems.push(...check.problems);
    if (typeof x.abstract_canonical === 'string') {
      if (utf8Length(x.abstract_canonical) !== x.abstract_bytes) problems.push('abstract_bytes no coincide con la cadena recibida');
      if (await sha256(x.abstract_canonical) !== x.abstract_sha256) problems.push('abstract_sha256 no coincide con la cadena recibida');
    }
    abstracts.push({ pmid: x.requested_pmid, sha256: x.abstract_sha256, ok: problems.length === 0, problems });
  }
  return { defects: d, attributable, abstracts };
}

// --- Usos (D4) --------------------------------------------------------------------------------------

/** Candidatos literales en la respuesta, con su intervalo en unidades UTF-16 (§4.4, R4 de Claude). */
export function extractCandidates(text) {
  const out = [];
  const add = (type, value, m, offset = 0) => out.push({ type, value, start: m.index + offset, end: m.index + m[0].length, text: m[0].slice(offset) });
  for (const m of text.matchAll(/\bPMID\s*:?\s*([0-9]{1,9})\b/gi)) add('pmid', m[1], m);
  for (const m of text.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/([0-9]{1,9})\b/gi)) add('pmid', m[1], m);
  // Un DOI puede llevar paréntesis (10.1016/S0140-6736(20)30183-5): solo se quita el cierre que sobra.
  for (const m of text.matchAll(/\b10\.[0-9]{4,9}\/[^\s"<>\]]+/g)) {
    let trimmed = m[0];
    for (let prev = ''; prev !== trimmed;) {
      prev = trimmed;
      trimmed = trimmed.replace(/[.,;:]+$/, '');
      if (trimmed.endsWith(')') && (trimmed.match(/\(/g) ?? []).length < (trimmed.match(/\)/g) ?? []).length) trimmed = trimmed.slice(0, -1);
    }
    out.push({ type: 'doi', value: trimmed.toLowerCase(), start: m.index, end: m.index + trimmed.length, text: trimmed });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end || (a.type < b.type ? -1 : 1));
}

const SOURCE_TYPES = ['pmid', 'doi', 'url'];
const sourceKey = (s) => (s.type === 'doi' ? `doi:${s.value.toLowerCase()}` : `${s.type}:${s.value}`);
const sourceError = (s) => {
  if (!isObj(s) || !SOURCE_TYPES.includes(s.type) || !isStr(s.value)) return 'source: { type: pmid|doi|url, value }';
  if (s.type === 'pmid' && !PMID_PATTERN.test(s.value)) return `source pmid «${s.value}» no es un PMID`;
  if (s.type === 'doi' && !/^10\.[0-9]{4,9}\//.test(s.value)) return `source doi «${s.value}» no es un DOI`;
  return null;
};

/**
 * Citas nativas resueltas o registro lateral de uso (§4.4). Cada uso se ata a un fragmento de LA
 * respuesta conservada; un ancla que no está es un defecto, un uso sin ancla verificable no suma D4.
 */
function checkUses(json, label, { responseSha, responseText, abstractRefs }) {
  const defects = [];
  const accredited = [];
  const unverified = [];
  const links = [];
  if (!isObj(json) || json.format !== FORMATS.uses || json.format_version !== 1 || !Array.isArray(json.uses)) {
    return { unreadable: `${label}: no es ${FORMATS.uses} versión 1`, defects, accredited, unverified, links, declaredBy: null };
  }
  if (json.response_sha256 !== responseSha) defects.push(`${label}: response_sha256 no es la huella de la respuesta conservada`);
  const declaredBy = ['agent', 'human', 'native_export'].includes(json.declared_by) ? json.declared_by : null;
  if (!declaredBy) defects.push(`${label}: declared_by debe ser agent, human o native_export`);
  json.uses.forEach((u, i) => {
    const at = `${label}.uses[${i}]`;
    const se = isObj(u) ? sourceError(u.source) : 'no es un objeto';
    if (se) { defects.push(`${at}: ${se}`); return; }
    const hasOffsets = Number.isSafeInteger(u.start) && Number.isSafeInteger(u.end);
    if (!isStr(u.fragment)) { unverified.push({ source: u.source, reason: 'sin fragmento de la respuesta' }); return; }
    const anchored = hasOffsets ? responseText.slice(u.start, u.end) === u.fragment : responseText.includes(u.fragment);
    if (!anchored) { defects.push(`${at}: el fragmento no está ${hasOffsets ? 'en ese intervalo de' : 'en'} la respuesta`); return; }
    if (u.abstract_ref !== undefined && u.abstract_ref !== null) {
      const ref = u.abstract_ref;
      // Se comprueba el PAR [pmid, huella]: un texto canónico no es exclusivo de un documento (R5).
      if (!isObj(ref) || !abstractRefs.has(tuple(ref.pmid, ref.abstract_sha256))) { defects.push(`${at}: abstract_ref no resuelve a un abstract íntegro conservado`); return; }
    }
    accredited.push({ source: { type: u.source.type, value: u.source.value }, fragment: u.fragment, via: label, declared_by: declaredBy });
  });
  for (const [i, l] of (Array.isArray(json.identity_links) ? json.identity_links : []).entries()) {
    if (!isObj(l) || !PMID_PATTERN.test(l.pmid ?? '') || !/^10\.[0-9]{4,9}\//.test(l.doi ?? '')) defects.push(`${label}.identity_links[${i}] no es { pmid, doi }`);
    else links.push({ pmid: l.pmid, doi: l.doi.toLowerCase(), via: label });
  }
  return { unreadable: null, defects, accredited, unverified, links, declaredBy };
}

// --- Temporalidad -------------------------------------------------------------------------------

/**
 * Orden entre dos sucesos (§4.2, P2 corregido por Codex). Con secuencia de una captura cerrada, la
 * secuencia. Con una cota de desfase justificada, solo si la separación la supera. Si no, `unknown`:
 * dentro de la tolerancia, con intervalos solapados o sin cota, no se infiere orden.
 */
function order(a, b, clock) {
  if (clock.sequence && Number.isSafeInteger(a.seq) && Number.isSafeInteger(b.seq)) {
    return a.seq < b.seq ? 'before' : a.seq > b.seq ? 'after' : 'unknown';
  }
  if (clock.bound === null || [a.start, a.end, b.start, b.end].some((t) => !Number.isFinite(t))) return 'unknown';
  if (a.end + clock.bound < b.start) return 'before';
  if (b.end + clock.bound < a.start) return 'after';
  return 'unknown';
}

// --- Comprobación -----------------------------------------------------------------------------------

/**
 * `load(path)` devuelve los bytes del archivo (Uint8Array) o null si no existe. Todo lo demás sale del
 * manifiesto. Devuelve el resultado completo; no escribe nada.
 *
 * Red de seguridad (revisión de Codex, R1): la forma de cada pieza se valida antes de usarla, pero si aun
 * así una entrada imprevista lanza una excepción, el resultado es `inconclusive` con su causa, nunca un
 * comprobador caído sin veredicto ni, desde luego, un aprobado.
 */
export async function checkDossier(manifest, load) {
  try {
    return await checkDossierUnguarded(manifest, load);
  } catch (err) {
    return finish({ manifest: manifestErrors(manifest).length ? null : manifest, defects: [], notices: [], exclusions: [],
      uncertainties: [{ code: 'checker_exception', detail: `entrada no prevista: ${String(err?.message ?? err).slice(0, 200)}` }] });
  }
}

async function checkDossierUnguarded(manifest, load) {
  const defects = [];
  const uncertainties = [];
  const notices = [];
  const exclusions = [];
  const defect = (code, detail) => defects.push({ code, detail });
  const uncertain = (code, detail) => uncertainties.push({ code, detail });

  const shapeErrors = manifestErrors(manifest);
  if (shapeErrors.length) {
    for (const e of shapeErrors) uncertain('manifest_invalid', e);
    return finish({ manifest: null, defects, uncertainties, notices, exclusions });
  }

  // 1. Archivos y huellas: lo que no está o no coincide no alimenta ninguna medida.
  const inputs = [];
  const readRef = async (role, ref) => {
    const bytes = await load(ref.file);
    const actual = bytes ? await sha256Bytes(bytes) : null;
    const status = bytes === null ? 'missing' : actual !== ref.sha256 ? 'hash_mismatch' : 'ok';
    inputs.push({ role, path: ref.file, sha256_declared: ref.sha256, sha256_actual: actual, status });
    if (status === 'missing') defect('file_missing', `${role}: falta ${ref.file}`);
    if (status === 'hash_mismatch') defect('hash_mismatch', `${role}: ${ref.file} no tiene la huella declarada`);
    return status === 'ok' ? bytes : null;
  };
  const decodeJson = (bytes, role) => {
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      uncertain('unreadable', `${role}: no es JSON UTF-8 legible`);
      return undefined;
    }
  };

  // 2. Cierre de la captura: lo prueba un registro externo de llamadas, no la etiqueta del perfil.
  const cap = manifest.capture;
  const clock = { bound: cap.clock ? cap.clock.skew_bound_ms : null, justification: cap.clock?.justification ?? null, sequence: false };
  let inventory = 'unknown';
  const sequenceOf = new Map();
  if (cap.closure) {
    const bytes = await readRef('capture.closure', cap.closure);
    const log = bytes && decodeJson(bytes, 'capture.closure');
    if (log !== undefined && log !== null) {
      if (!isObj(log) || log.format !== FORMATS.capture_log || log.format_version !== 1 || !Array.isArray(log.calls)) {
        uncertain('unreadable', `capture.closure: no es ${FORMATS.capture_log} versión 1`);
      } else if (log.dossier_id !== manifest.dossier_id || log.closed !== true) {
        defect('closure_mismatch', 'capture.closure: otro dossier o captura no cerrada');
      } else {
        const logged = new Map(log.calls.map((c) => [c?.external_id, c]));
        const listed = manifest.attempts.map((a) => a.external_id);
        const missingInLog = listed.filter((id) => !isStr(id) || !logged.has(id));
        const missingInInventory = [...logged.keys()].filter((id) => !listed.includes(id));
        if (logged.size !== log.calls.length || log.calls.some((c) => !isStr(c?.external_id) || !TOOLS.includes(c?.tool))) {
          defect('closure_mismatch', 'capture.closure: llamadas sin external_id o herramienta válidos, o repetidas');
        } else if (missingInLog.length || missingInInventory.length) {
          defect('closure_mismatch', `inventario y captura no coinciden: fuera de la captura ${JSON.stringify(missingInLog)}, `
            + `fuera del inventario ${JSON.stringify(missingInInventory)}`);
        } else if (manifest.attempts.some((a) => logged.get(a.external_id).tool !== a.tool)) {
          defect('closure_mismatch', 'inventario y captura discrepan en la herramienta de algún intento');
        } else {
          inventory = 'closed';
          for (const [id, c] of logged) if (Number.isSafeInteger(c.sequence)) sequenceOf.set(id, c.sequence);
          clock.sequence = sequenceOf.size === logged.size && new Set(sequenceOf.values()).size === sequenceOf.size;
        }
      }
    }
  }
  if (inventory !== 'closed') {
    uncertain('inventory_unknown', `inventario sin cierre acreditado (perfil ${manifest.profile}, inventariado por ${cap.inventory_by}): `
      + 'se mide lo conservado, no se aprueba la ejecución entera');
  }

  // 3. Intentos: lectura, envoltura, clase, duplicados.
  const admitted = new Map(manifest.plans.map((p) => [p.plan_ref, new Set(p.passes)]));
  const attempts = [];
  const unanswered = [];
  const byIdentity = new Map();
  for (const a of manifest.attempts) {
    const entry = { attempt_ref: a.attempt_ref, tool: a.tool, external_id: a.external_id ?? null, captured: a.captured ?? null,
      kind: null, status: 'ok', duplicate_of: null, sequence: sequenceOf.get(a.external_id) ?? null };
    attempts.push(entry);
    if (!a.file) {
      entry.status = 'no_response';
      entry.kind = 'no_response';
      notices.push(`${a.attempt_ref}: intento sin respuesta (${a.absent_reason})`);
      // Una lectura sin respuesta no desaparece (revisión de Codex, R3): con la petición conservada, sus PMID
      // quedan por resolver; sin ella, no se sabe qué se pidió y el dossier no puede aprobar.
      if (a.tool === 'pubmed_fetch_exact') {
        if (a.request) unanswered.push({ attempt_ref: a.attempt_ref, pmids: a.request.pmids, seq: entry.sequence });
        else uncertain('reading_without_response', `${a.attempt_ref}: lectura sin respuesta y sin la petición conservada: no se sabe qué PMID quedaron sin leer`);
      }
      continue;
    }
    const bytes = await readRef(`attempt ${a.attempt_ref}`, a);
    if (!bytes) { entry.status = 'file_defect'; continue; }
    const json = decodeJson(bytes, `attempt ${a.attempt_ref}`);
    if (json === undefined) { entry.status = 'unreadable'; continue; }
    if (a.tool === 'other') { entry.kind = 'alternative_route'; continue; }
    const { payload, textMismatch } = unwrap(json);
    if (textMismatch) defect('envelope_mismatch', `${a.attempt_ref}: el texto de la envoltura no dice lo mismo que structuredContent`);
    entry.kind = kindOf(payload);
    entry.payload = payload;
    entry.manifest = a;
    const expectedTool = { search: 'pubmed_search_exact', search_error: 'pubmed_search_exact', fetch: 'pubmed_fetch_exact', fetch_rejected: 'pubmed_fetch_exact' }[entry.kind];
    if (entry.kind === 'unknown') { uncertain('unsupported_input', `${a.attempt_ref}: formato de respuesta no reconocido`); entry.status = 'unreadable'; continue; }
    if (expectedTool !== a.tool) { defect('tool_mismatch', `${a.attempt_ref}: el inventario dice ${a.tool} y el archivo es ${entry.kind}`); entry.status = 'tool_mismatch'; continue; }
    // La forma, antes de leer ningún campo (R1): lo que no la tiene no se interpreta ni tumba el comprobador.
    const shape = entry.kind === 'search' ? searchShapeErrors(payload) : entry.kind === 'fetch' ? fetchShapeErrors(payload)
      : entry.kind === 'fetch_rejected' ? rejectionShapeErrors(payload) : [];
    if (shape.length) {
      const expected = { search: 'pubmed_search_exact 1.13+', fetch: `${FETCH_RECEIPT_TYPE}/${FETCH_RECEIPT_VERSION}`,
        fetch_rejected: `rechazo de ${FETCH_RECEIPT_TYPE}/${FETCH_RECEIPT_VERSION}` }[entry.kind];
      uncertain('unsupported_input', `${a.attempt_ref}: recibo sin la forma de ${expected} (${shape.slice(0, 8).join(', ')})`);
      entry.status = 'unsupported';
      continue;
    }
    // Identidad del intento: la del inventario, o la del propio recibo. Una copia repetida no cuenta dos veces.
    const identity = a.external_id ? tuple('ext', a.external_id)
      : entry.kind === 'fetch' || entry.kind === 'fetch_rejected' ? tuple('fetch', payload.attempt_id)
        : entry.kind === 'search' ? tuple('search', payload.executed_at, payload.raw_response_sha256, payload.sent_query_sha256, payload.request?.retstart ?? 0)
          : tuple('file', a.sha256);
    const prior = byIdentity.get(identity);
    if (prior) {
      if (JSON.stringify(prior.payload) === JSON.stringify(payload)) {
        entry.status = 'duplicate_copy';
        entry.duplicate_of = prior.attempt_ref;
        notices.push(`${a.attempt_ref}: copia del mismo intento que ${prior.attempt_ref}; cuenta una vez`);
      } else {
        entry.status = 'conflict';
        defect('attempt_conflict', `${a.attempt_ref} y ${prior.attempt_ref} dicen ser el mismo intento con contenidos distintos`);
      }
      continue;
    }
    byIdentity.set(identity, entry);
  }
  const live = attempts.filter((e) => e.status === 'ok');
  const alternative = attempts.filter((e) => e.kind === 'alternative_route').map((e) => e.attempt_ref);
  if (alternative.length) notices.push(`ruta alternativa (otro conector) en ${alternative.join(', ')}: se registra, no se convierte en lectura exacta`);

  // 4. Búsqueda: validación, pasada, recorrido.
  const walks = new Map();
  const declarations = [];
  const validLists = [];
  for (const e of live.filter((x) => x.kind === 'search' || x.kind === 'search_error')) {
    const p = e.payload;
    const a = e.manifest;
    const rec = e.kind === 'search' ? p.selection_record?.record : undefined;
    const recPlan = rec?.plan_ref ?? null;
    const recPass = rec?.pass?.pass_id ?? null;
    if ((a.plan_ref && recPlan && a.plan_ref !== recPlan) || (a.pass_id && recPass && a.pass_id !== recPass)) {
      defect('walk_conflict', `${e.attempt_ref}: el manifiesto y el registro de selección declaran pasadas distintas`);
      e.status = 'conflict';
      continue;
    }
    const plan = recPlan ?? a.plan_ref ?? null;
    const pass = recPass ?? a.pass_id ?? null;
    let key = null;
    if (plan && pass) {
      if (!admitted.has(plan) || !admitted.get(plan).has(pass)) defect('outside_plan', `${e.attempt_ref}: [${plan}, ${pass}] no es un plan y pasada admitidos en el dossier`);
      key = tuple(plan, pass, a.walk_id ?? null);
    } else {
      uncertain('walk_unknown', `${e.attempt_ref}: búsqueda sin plan y pasada atribuibles`);
    }
    const w = key && (walks.get(key) ?? walks.set(key, { key, plan_ref: plan, pass_id: pass, walk_id: a.walk_id ?? null, pages: [], failed: [], reading_paths: new Set() }).get(key));
    if (e.kind === 'search_error') {
      w?.failed.push(e.attempt_ref);
      exclusions.push({ attempt_ref: e.attempt_ref, reason: `búsqueda fallida: ${p.error.slice(0, 160)}` });
      continue;
    }
    const sd = await searchDefects(p);
    for (const d of sd) defect('search_receipt', `${e.attempt_ref}: ${d}`);
    if (sd.length) { exclusions.push({ attempt_ref: e.attempt_ref, reason: 'recibo de búsqueda con huellas o estructura incorrectas' }); continue; }
    if (p.status.selection_record === 'inconsistent') notices.push(`${e.attempt_ref}: registro de selección inconsistent (no cambia la integridad de la consulta)`);
    for (const k of rec?.known_pmids ?? []) {
      declarations.push({ pmid: k.pmid, origin: k.origin, detail: k.detail ?? null, attempt_ref: e.attempt_ref,
        at: p.selection_record.received_at, seq: e.sequence });
    }
    if (p.status.query_integrity !== 'verified') {
      exclusions.push({ attempt_ref: e.attempt_ref, reason: `integridad ${p.status.query_integrity}: su lista (${p.pmids.length} PMID) no entra en los devueltos válidos` });
      w?.failed.push(e.attempt_ref);
      continue;
    }
    if (rec?.pass?.reading_path) w?.reading_paths.add(rec.pass.reading_path);
    const page = { attempt_ref: e.attempt_ref, receipt: p, at: Date.parse(p.executed_at), seq: e.sequence };
    w?.pages.push(page);
    validLists.push({ walk: key, ...page });
  }

  const passes = [];
  for (const w of [...walks.values()].sort((x, y) => (x.key < y.key ? -1 : 1))) {
    const queries = new Set(w.pages.map((pg) => `${pg.receipt.sent_query_sha256}|${pg.receipt.request?.sort ?? null}`));
    const conflicts = [];
    if (queries.size > 1) conflicts.push('la misma pasada con consultas u órdenes distintos: no se fusionan; declara walk_id distintos');
    // Una página repetida idéntica es otro intento del mismo tramo; distinta en el mismo tramo, un conflicto.
    const byStart = new Map();
    for (const pg of w.pages) {
      const s = pg.receipt.request?.retstart ?? 0;
      const prev = byStart.get(s);
      if (!prev) byStart.set(s, pg);
      else if (prev.receipt.pmid_list_sha256 === pg.receipt.pmid_list_sha256 && prev.receipt.result_count === pg.receipt.result_count) {
        notices.push(`${pg.attempt_ref}: repite el tramo ${s + 1} de ${prev.attempt_ref} con la misma lista; no añade PMID`);
      } else conflicts.push(`el tramo que empieza en ${s} tiene listas distintas (${prev.attempt_ref}, ${pg.attempt_ref})`);
    }
    for (const c of conflicts) defect('walk_conflict', `[${w.plan_ref}, ${w.pass_id}${w.walk_id ? `, ${w.walk_id}` : ''}]: ${c}`);
    const counts = w.pages.map((pg) => ({ attempt_ref: pg.attempt_ref, retstart: pg.receipt.request?.retstart ?? 0, result_count: pg.receipt.result_count }));
    const distinct = [...new Set(counts.map((c) => c.result_count).filter((c) => c !== null))];
    // Recuentos distintos en una pasada: conflicto sin elegir y defecto del dossier, aunque otra pasada
    // sí se mida y aunque no se declarara recuperación completa (revisión de Codex, R4).
    if (distinct.length > 1) defect('count_conflict', `[${w.plan_ref}, ${w.pass_id}${w.walk_id ? `, ${w.walk_id}` : ''}]: recuentos distintos entre páginas (${distinct.join(', ')})`);
    const pmids = sortPmids(w.pages.flatMap((pg) => pg.receipt.pmids));
    let union = null;
    if (w.reading_paths.has('complete_retrieval')) {
      union = checkPageUnion([...byStart.values()].map((pg) => pg.receipt));
      if (union.status !== OPERATIONAL) defect('union_failed', `[${w.plan_ref}, ${w.pass_id}]: recuperación declarada completa que no pasa la unión: ${union.problems.join('; ')}`);
    }
    passes.push({
      plan_ref: w.plan_ref, pass_id: w.pass_id, walk_id: w.walk_id, attempts_valid: w.pages.map((pg) => pg.attempt_ref), attempts_failed: w.failed,
      reading_paths: [...w.reading_paths].sort(),
      d1: {
        value: conflicts.length || distinct.length > 1 ? null : distinct[0] ?? null, unit: 'result_count',
        status: conflicts.length || distinct.length > 1 ? 'conflict' : distinct.length === 1 ? 'measured' : 'not_measured',
        observed: counts,
      },
      returned: pmids,
      union: union && { status: union.status, label: union.label, problems: union.problems, not_guaranteed: union.not_guaranteed },
      _unionPmids: union?.status === OPERATIONAL ? union.pmids : null,
      _key: w.key,
      _sent_query: [...new Set(w.pages.map((pg) => pg.receipt.sent_query))],
    });
  }
  const S = sortPmids(validLists.flatMap((l) => l.receipt.pmids));
  const raw = validLists.reduce((n, l) => n + l.receipt.pmids.length, 0);
  const passOf = new Map();
  for (const p of passes) for (const id of p.returned) passOf.set(id, [...(passOf.get(id) ?? []), [p.plan_ref, p.pass_id, p.walk_id]]);
  const overlap = sortPmids([...passOf].filter(([, ps]) => ps.length > 1).map(([id]) => id));
  if (!live.some((e) => e.kind === 'search')) uncertain('no_exact_search', 'el dossier no tiene búsquedas exactas válidas: puede estar bien formado y no acreditar el recorrido previsto');

  // 5. Lectura: recibos, abstracts, versiones.
  const reads = live.filter((e) => e.kind === 'fetch');
  const perPmid = new Map();
  // Abstracts íntegros y atribuibles, por PAR [pmid, huella]: dos PMID pueden tener el mismo texto (R5).
  const abstractRefs = new Set();
  const readIds = new Map();
  const slotOf = (pmid) => perPmid.get(pmid) ?? perPmid.set(pmid, { attempts: [], outcomes: [], versions: new Map(), dois: new Set() }).get(pmid);
  for (const e of live.filter((x) => x.kind === 'fetch_rejected')) notices.push(`${e.attempt_ref}: lectura rechazada antes de NCBI (${String(e.payload.error).slice(0, 160)})`);
  for (const e of reads) {
    const p = e.payload;
    const { defects: fd, attributable, abstracts } = await fetchDefects(p);
    for (const d of fd) defect('fetch_receipt', `${e.attempt_ref}: ${d}`);
    const plan = p.request.context?.plan_ref;
    if (!admitted.has(plan)) defect('outside_plan', `${e.attempt_ref}: plan_ref «${plan}» no es un plan admitido en el dossier`);
    const rid = p.request.context?.read_id;
    const sig = JSON.stringify(p.request.pmids);
    if (readIds.has(rid) && readIds.get(rid) !== sig) defect('read_id_reused', `${e.attempt_ref}: read_id «${rid}» reutilizado para otra lectura`);
    readIds.set(rid, readIds.get(rid) ?? sig);
    e.window = { start: Date.parse(p.received_at), end: Date.parse(p.completed_at ?? p.received_at), seq: e.sequence };
    const goodSha = new Map(abstracts.filter((x) => x.ok).map((x) => [x.pmid, x]));
    for (const x of abstracts.filter((y) => !y.ok)) defect('abstract_gap', `${e.attempt_ref}: PMID ${x.pmid}: ${x.problems.join('; ')}`);
    for (const pmid of p.request.pmids) {
      const slot = slotOf(pmid);
      slot.attempts.push(e);
      const result = p.results.find((r) => r.requested_pmid === pmid);
      const pend = p.pending_pmids.find((r) => r.pmid === pmid);
      let outcome = pend ? 'pending' : result?.record_status ?? 'missing';
      // Un registro o una ausencia que no se pueden atribuir válidamente a este PMID no cuentan (R2).
      if (['with_abstract', 'without_abstract', 'not_found'].includes(outcome) && !attributable.has(pmid)) outcome = 'not_attributable';
      if (outcome === 'with_abstract') {
        const good = goodSha.get(pmid);
        if (!good) outcome = 'abstract_gap';
        else {
          const v = slot.versions.get(good.sha256) ?? slot.versions.set(good.sha256, { abstract_sha256: good.sha256, attempts: [], completed_at: [] }).get(good.sha256);
          if (v.attempts.length) notices.push(`PMID ${pmid}: ${e.attempt_ref} repite idéntico el abstract de ${v.attempts[0]}; cuenta una vez`);
          v.attempts.push(e.attempt_ref);
          v.completed_at.push(p.completed_at ?? null);
          abstractRefs.add(tuple(pmid, good.sha256));
        }
      }
      if (result && attributable.has(pmid) && ['with_abstract', 'without_abstract'].includes(result.record_status)) {
        for (const doi of result.dois) if (typeof doi === 'string') slot.dois.add(doi.toLowerCase());
      }
      slot.outcomes.push({ attempt_ref: e.attempt_ref, outcome, reason: pend?.reason ?? result?.reason ?? null });
    }
  }
  // Lecturas sin respuesta con la petición conservada: sus PMID quedan por resolver, salvo que otra
  // lectura los resuelva (R3). Sin hora de servidor, su orden solo sale de la secuencia de la captura.
  for (const u of unanswered) {
    for (const pmid of u.pmids) {
      const slot = slotOf(pmid);
      slot.attempts.push({ window: { start: NaN, end: NaN, seq: u.seq } });
      slot.outcomes.push({ attempt_ref: u.attempt_ref, outcome: 'no_response', reason: 'sin respuesta conservada' });
    }
  }
  const RANK = ['with_abstract', 'without_abstract', 'not_found', 'error', 'pending', 'abstract_gap', 'not_attributable', 'no_response', 'missing'];
  const finalOf = (slot) => (slot.versions.size ? 'obtained'
    : RANK.slice(1).find((r) => slot.outcomes.some((o) => o.outcome === r)) ?? 'missing');
  const requestedPmids = sortPmids(perPmid.keys());
  const classes = { obtained: [], without_abstract: [], not_found: [], error: [], pending: [], abstract_gap: [], not_attributable: [], no_response: [], missing: [] };
  for (const pmid of requestedPmids) classes[finalOf(perPmid.get(pmid))].push(pmid);
  const unresolved = [...classes.error, ...classes.pending, ...classes.abstract_gap, ...classes.not_attributable, ...classes.no_response, ...classes.missing];
  if (unresolved.length) defect('reading_incomplete', `lecturas pedidas sin registro completo ni ausencia contabilizada: ${unresolved.join(', ')}`);
  const multiVersion = requestedPmids.filter((p) => perPmid.get(p).versions.size > 1);
  for (const p of multiVersion) notices.push(`PMID ${p}: ${perPmid.get(p).versions.size} versiones completas distintas; se conservan separadas y cuenta una vez`);

  // 6. Respuesta y usos (D4).
  let responseText = null;
  let responseSha = null;
  if (manifest.response) {
    const bytes = await readRef('response', manifest.response);
    if (bytes) {
      try {
        responseText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        responseSha = await sha256Bytes(bytes);
      } catch { uncertain('unreadable', 'response: no es texto UTF-8'); }
    }
  }
  const candidates = responseText === null ? [] : extractCandidates(responseText);
  const useSources = [];
  const useReports = [];
  for (const k of ['citations', 'usage_log']) {
    if (!manifest[k]) continue;
    const bytes = await readRef(k, manifest[k]);
    const json = bytes && decodeJson(bytes, k);
    if (json === undefined || json === null) continue;
    if (responseText === null) { uncertain('d4_unanchored', `${k}: no hay respuesta conservada contra la que comprobar las anclas`); continue; }
    const r = checkUses(json, k, { responseSha, responseText, abstractRefs });
    if (r.unreadable) { uncertain('unreadable', r.unreadable); continue; }
    for (const d of r.defects) defect('use_anchor', d);
    useSources.push(r);
    useReports.push({ file: k, declared_by: r.declaredBy, accredited: r.accredited.length, unverified: r.unverified });
  }
  // Identidad PMID-DOI solo con correspondencia explícita: un enlace declarado o el DOI del propio registro leído.
  const parent = new Map();
  const find = (k) => { while (parent.has(k) && parent.get(k) !== k) k = parent.get(k); return k; };
  const join2 = (a, b) => { parent.set(a, find(a)); parent.set(b, find(b)); parent.set(find(a), find(b)); };
  for (const r of useSources) for (const l of r.links) join2(`pmid:${l.pmid}`, `doi:${l.doi}`);
  for (const [pmid, slot] of perPmid) for (const doi of slot.dois) join2(`pmid:${pmid}`, `doi:${doi}`);
  const accredited = useSources.flatMap((r) => r.accredited);
  const docs = new Map();
  for (const u of accredited) {
    const root = find(sourceKey(u.source));
    const doc = docs.get(root) ?? docs.set(root, { keys: new Set(), via: new Set() }).get(root);
    doc.keys.add(sourceKey(u.source));
    doc.via.add(u.via);
  }
  // Un documento con un PMID en su identidad (explícita) cuenta como fuente PMID.
  const pmidsOfDoc = (doc) => {
    const out = new Set([...doc.keys].filter((k) => k.startsWith('pmid:')).map((k) => k.slice(5)));
    for (const [k] of parent) if (k.startsWith('pmid:') && [...doc.keys].some((dk) => find(dk) === find(k))) out.add(k.slice(5));
    return [...out];
  };
  const docList = [...docs.values()].map((d) => ({ identity: [...d.keys].sort(), pmids: sortPmids(pmidsOfDoc(d)), via: [...d.via].sort() }))
    .sort((a, b) => (a.identity[0] < b.identity[0] ? -1 : 1));
  const U = sortPmids(docList.flatMap((d) => d.pmids));
  const linkedKeys = new Set(accredited.map((u) => find(sourceKey(u.source))));
  const mentionsWithoutUse = candidates.filter((c) => !linkedKeys.has(find(c.type === 'doi' ? `doi:${c.value}` : `pmid:${c.value}`)));
  // D4 se mide con usos resueltos o con cero usos declarado explícitamente (`uses: []`). Usos declarados sin
  // ancla comprobable no son cero usos demostrados (revisión de Codex, R9): si no se acredita ninguno, D4
  // no se mide; si solo parte, queda parcial. En los dos casos el dossier no aprueba.
  const unverifiedUses = useSources.flatMap((r) => r.unverified);
  const d4Measured = responseText !== null && useSources.length > 0 && !(accredited.length === 0 && unverifiedUses.length > 0);
  if (!d4Measured) {
    uncertain('d4_not_measured', responseText === null
      ? 'sin respuesta conservada: D4 no medido'
      : useSources.length === 0 ? 'sin citas nativas resueltas ni registro de uso: las menciones quedan como candidatos y D4 no se mide'
        : `${unverifiedUses.length} uso(s) declarado(s) sin ancla comprobable y ninguno acreditado: D4 no se mide`);
  } else if (unverifiedUses.length) {
    uncertain('d4_partial', `${unverifiedUses.length} uso(s) declarado(s) sin ancla comprobable: D4 cuenta solo lo acreditado`);
  }
  const anchorFailures = defects.filter((d) => d.code === 'use_anchor').length;

  // 7. Procedencia y temporalidad por PMID.
  const knownBy = new Map();
  for (const d of declarations) knownBy.set(d.pmid, [...(knownBy.get(d.pmid) ?? []), d]);
  const provenanceSet = sortPmids([...requestedPmids, ...U]);
  const provenance = provenanceSet.map((pmid) => {
    const lists = validLists.filter((l) => l.receipt.pmids.includes(pmid)).map((l) => {
      const w = l.walk ? JSON.parse(l.walk) : [null, null, null];
      return { attempt_ref: l.attempt_ref, plan_ref: w[0], pass_id: w[1], walk_id: w[2], retstart: l.receipt.request?.retstart ?? 0, executed_at: l.receipt.executed_at };
    });
    const known = knownBy.get(pmid) ?? [];
    const membership = lists.length && known.length ? 'both' : lists.length ? 'returned' : known.length ? 'known_only' : 'unattributed';
    const fetches = (perPmid.get(pmid)?.attempts ?? []).map((e) => e.window);
    let temporality = null;
    if (known.length && fetches.length) {
      const rel = known.map((k) => {
        const ev = { start: Date.parse(k.at), end: Date.parse(k.at), seq: k.seq };
        const each = fetches.map((f) => order(ev, f, clock));
        return each.every((x) => x === 'before') ? 'before' : each.some((x) => x === 'after') ? 'after' : 'unknown';
      });
      temporality = rel.includes('before') ? 'declared_before_fetch' : rel.includes('after') ? 'declared_after_fetch' : 'unknown';
    }
    const slot = perPmid.get(pmid);
    return {
      pmid, membership, temporality,
      lists,
      known_pmids: known.map((k) => ({ origin: k.origin, detail: k.detail, attempt_ref: k.attempt_ref, received_at: k.at, clock_source: 'server' })),
      reading: slot ? { final: finalOf(slot), outcomes: slot.outcomes, versions: [...slot.versions.values()] } : null,
      used: U.includes(pmid),
    };
  });

  // 8. Retención frente a referencia (§4.5).
  let retention = { status: 'not_measured', reason: 'sin referencia' };
  if (manifest.reference) {
    const bytes = await readRef('reference', manifest.reference);
    const json = bytes && decodeJson(bytes, 'reference');
    const ref = json ? referenceFrom(json, manifest.reference.case_id) : null;
    if (json && ref.error) uncertain('unreadable', `reference: ${ref.error}`);
    if (ref && !ref.error) {
      const R = ref.target;
      const stage = (set, label) => {
        const hits = R.filter((p) => set.has(p));
        return { stage: label, numerator: hits.length, denominator: R.length, ratio: R.length ? hits.length / R.length : null,
          hits: sortPmids(hits), missing: sortPmids(R.filter((p) => !set.has(p))) };
      };
      const synth = (set) => sortPmids(ref.synthesis.filter((p) => set.has(p)));
      const within = [];
      for (const p of passes) {
        if (p._unionPmids) within.push({ plan_ref: p.plan_ref, pass_id: p.pass_id, walk_id: p.walk_id, via: OPERATIONAL_LABEL, ...stage(new Set(p._unionPmids), 'within_query') });
      }
      for (const [i, x] of (manifest.intersections ?? []).entries()) {
        const r = await intersectionRetention(x, i, { readRef, decodeJson, passes, R, stage });
        if (r.defect) defect('intersection', r.defect);
        if (r.result) within.push(r.result);
      }
      const usedSet = new Set(U);
      retention = {
        status: 'measured',
        reference: { reference_id: ref.id, version: ref.version, source: ref.source, partial: ref.partial, target_size: R.length, synthesis_pmids: ref.synthesis },
        stages: [stage(new Set(S), 'returned'), stage(new Set(classes.obtained), 'abstracts_preserved'),
          d4Measured ? stage(usedSet, 'documented_use') : { stage: 'documented_use', status: 'not_measured', ratio: null }],
        per_pass: passes.map((p) => ({ plan_ref: p.plan_ref, pass_id: p.pass_id, walk_id: p.walk_id, ...stage(new Set(p.returned), 'returned') })),
        synthesis: { returned: synth(new Set(S)), abstracts_preserved: synth(new Set(classes.obtained)), documented_use: d4Measured ? synth(usedSet) : null,
          note: 'una síntesis cuenta como un documento; no acredita la lectura de sus primarios' },
        outside_reference: { returned: S.filter((p) => !R.includes(p) && !ref.synthesis.includes(p)).length },
        within_query: within.length ? within : { status: 'not_measured', reason: 'sin recuperación completa que pase la unión ni intersección conservada' },
      };
    }
  }

  const d3Status = unresolved.length ? 'partial' : 'measured';
  const denominators = {
    D1: { unit: 'result_count por pasada; no se suman pasadas', per_pass: passes.map((p) => ({ plan_ref: p.plan_ref, pass_id: p.pass_id, walk_id: p.walk_id, ...p.d1 })) },
    D2: { value: S.length, unit: 'PMID únicos devueltos en listas válidas', status: validLists.length ? 'measured' : 'not_measured',
      raw_appearances: raw, overlap, per_pass: passes.map((p) => ({ plan_ref: p.plan_ref, pass_id: p.pass_id, walk_id: p.walk_id, value: p.returned.length })),
      excluded: exclusions.map((x) => x.attempt_ref) },
    D3: { value: classes.obtained.length, unit: 'PMID únicos con abstract íntegro conservado', status: d3Status,
      requested_unique: requestedPmids.length, attempts: reads.length, obtained: classes.obtained, without_abstract: classes.without_abstract,
      not_found: classes.not_found, error: classes.error, pending: classes.pending, abstract_gap: classes.abstract_gap,
      not_attributable: classes.not_attributable, no_response: classes.no_response, multiple_versions: multiVersion },
    D4: d4Measured
      ? { value: docList.length, unit: 'documentos únicos con uso anclado en la respuesta', status: anchorFailures || unverifiedUses.length ? 'partial' : 'measured',
        pmid_sources: docList.filter((d) => d.pmids.length).length, other_sources: docList.filter((d) => !d.pmids.length).length,
        documents: docList, used_without_preserved_abstract: U.filter((p) => !classes.obtained.includes(p)),
        mentions_without_use_evidence: mentionsWithoutUse, uses: useReports }
      : { value: null, unit: 'documentos únicos con uso anclado en la respuesta', status: 'not_measured', mentions_without_use_evidence: mentionsWithoutUse,
        declared_unverified: unverifiedUses },
  };
  if (!passes.some((p) => p.d1.status === 'measured')) uncertain('d1_not_measured', 'ninguna pasada tiene D1 medido');

  return finish({
    manifest, defects, uncertainties, notices, exclusions,
    body: {
      capture: { method: cap.method, inventory_by: cap.inventory_by, inventory_completeness: inventory,
        clock: { source: 'server', skew_bound_ms: clock.bound, justification: clock.justification, sequence: clock.sequence ? 'capture_log' : null },
        transcribed: attempts.filter((e) => e.captured === 'transcribed').map((e) => e.attempt_ref) },
      inputs,
      attempts: attempts.map(({ payload, manifest: _m, window: _w, ...rest }) => rest),
      passes: passes.map(({ _unionPmids, _key, _sent_query, d1, returned, ...rest }) => ({ ...rest, returned_size: returned.length })),
      denominators,
      provenance,
      retention,
      alternative_route: alternative,
    },
  });
}

/** Referencia propia o un caso de cases.json (reference.pmids, con la revisión de origen como síntesis). */
function referenceFrom(json, caseId) {
  let ref;
  if (Array.isArray(json?.cases)) {
    const c = json.cases.find((x) => x?.id === caseId);
    if (!c?.reference) return { error: `no hay caso «${caseId}» con referencia en cases.json` };
    ref = { id: `cases.json#${caseId}`, version: null, source: c.reference.source_pmid ? `PMID ${c.reference.source_pmid}` : null,
      partial: c.reference.complete === false, target: c.reference.pmids, synthesis: c.reference.source_pmid ? [c.reference.source_pmid] : [] };
  } else if (isObj(json) && json.format === FORMATS.reference && json.format_version === 1) {
    ref = { id: json.reference_id, version: json.version ?? null, source: json.source ?? null, partial: json.partial === true,
      target: json.target_pmids, synthesis: json.synthesis_pmids ?? [] };
  } else return { error: `no es ${FORMATS.reference} versión 1 ni cases.json` };
  for (const k of ['target', 'synthesis']) {
    if (!Array.isArray(ref[k]) || !ref[k].every((p) => typeof p === 'string' && PMID_PATTERN.test(p))) return { error: `${k}: lista de PMID` };
    if (new Set(ref[k]).size !== ref[k].length) return { error: `${k}: PMID repetidos` };
  }
  if (!isStr(ref.id)) return { error: 'reference_id obligatorio' };
  if (ref.synthesis.some((p) => ref.target.includes(p))) return { error: 'una síntesis no va entre los primarios objetivo' };
  return ref;
}

/**
 * Retención dentro de una consulta con un recibo de intersección conservado: `(<original>) AND (<R en
 * OR con [pmid]>)`, verificado y con la lista entera. Se comprueba la composición; no se ejecuta.
 */
async function intersectionRetention(x, i, { readRef, decodeJson, passes, R, stage }) {
  const at = `intersections[${i}]`;
  const bytes = await readRef(at, x);
  const json = bytes && decodeJson(bytes, at);
  if (!json) return {};
  const r = unwrap(json).payload;
  if (kindOf(r) !== 'search') return { defect: `${at}: no es un recibo de búsqueda` };
  const sd = await searchDefects(r);
  if (sd.length) return { defect: `${at}: ${sd.join('; ')}` };
  const pass = passes.find((p) => p.plan_ref === x.plan_ref && p.pass_id === x.pass_id && p.walk_id === (x.walk_id ?? null));
  if (!pass || pass._sent_query.length !== 1) return { defect: `${at}: la pasada original no existe o no tiene una sola consulta` };
  const prefix = `(${pass._sent_query[0]}) AND (`;
  const list = r.sent_query.startsWith(prefix) && r.sent_query.endsWith(')') ? r.sent_query.slice(prefix.length, -1) : null;
  const ids = list && /^[0-9]+\[pmid\]( OR [0-9]+\[pmid\])*$/.test(list) ? list.split(' OR ').map((t) => t.slice(0, -6)) : null;
  if (!ids || ids.length !== R.length || new Set(ids).size !== ids.length || !ids.every((p) => R.includes(p))) {
    return { defect: `${at}: la consulta no es (<original>) AND (<la referencia en OR con [pmid]>)` };
  }
  if (r.status.query_integrity !== 'verified' || r.records_complete !== true) return { defect: `${at}: intersección sin integridad verificada o sin la lista entera` };
  if (!r.pmids.every((p) => R.includes(p))) return { defect: `${at}: la intersección devuelve PMID fuera de la referencia` };
  return { result: { plan_ref: x.plan_ref, pass_id: x.pass_id, walk_id: x.walk_id ?? null, via: 'intersección conservada (mide su momento, no la búsqueda histórica)',
    executed_at: r.executed_at, ...stage(new Set(r.pmids), 'within_query') } };
}

function finish({ manifest, defects, uncertainties, notices, exclusions, body = {} }) {
  const verdict = defects.length ? 'incomplete' : uncertainties.length ? 'inconclusive' : 'consistent';
  return {
    checker: { name: 'dossier-check', version: CHECKER_VERSION },
    formats: { ...FORMATS, fetch_receipt: `${FETCH_RECEIPT_TYPE}/${FETCH_RECEIPT_VERSION}`, abstract: ABSTRACT_FORMAT, offsets: 'utf16_code_unit' },
    dossier: manifest ? { dossier_id: manifest.dossier_id, case: manifest.case ?? null, condition: manifest.condition ?? null, profile: manifest.profile } : null,
    verdict,
    exit_code: VERDICTS[verdict],
    meaning: verdict === 'consistent'
      ? 'las piezas exigidas están presentes y los controles mecánicos pasan, bajo la procedencia declarada'
      : verdict === 'incomplete' ? 'hay al menos un defecto demostrado' : 'sin defecto demostrado, falta material o cierre para decidir',
    defects,
    uncertainties,
    ...body,
    exclusions,
    notices,
    limits: LIMITS,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error('Uso: node scripts/dossier-check.mjs ruta/al/manifiesto.json');
    process.exit(2);
  }
  const base = dirname(resolve(file));
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`No se puede leer el manifiesto: ${e.message}`);
    process.exit(2);
  }
  const load = async (p) => {
    if (!safePath(p)) return null;
    try { return new Uint8Array(readFileSync(join(base, ...p.split('/')))); } catch { return null; }
  };
  const result = await checkDossier(manifest, load);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.exit_code;
}
