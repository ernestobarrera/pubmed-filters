/**
 * Núcleo del cribado por PMID con recibo, `pubmed_summary_exact` (diseño 33-, alternativa b; contrato
 * 1.15.0). Hermano de `fetch-core.mjs` y, como él, código PURO (fetch, Web Crypto, sin disco): lo
 * comparten el MCP local y el Worker.
 *
 * POR QUÉ EXISTE. El recibo de búsqueda trae PMID, no títulos, y cribar una pasada entera obligaba a
 * leer abstracts de cinco en cinco: en la lumbalgia del 26/10, 59 registros eran unas 12 lecturas, y
 * quedarse con 15 era la conducta racional. Con ESummary van hasta 50 por llamada, y lo que no cabe en el
 * presupuesto queda pendiente: 59 son al menos dos llamadas.
 *
 * QUÉ ACREDITA. Qué se pidió, qué devolvió NCBI y qué se entregó: por PMID pedido, título, año, tipos,
 * revista, DOI y si NCBI marca que tiene abstract; o pendiente explícito; o error con motivo. Nunca
 * cortado, sustituido ni asociado por posición. QUÉ NO (33-, §5): que un título se leyera o se entendiera;
 * que lo apartado por título no sea pertinente; que un registro sirva de hallazgo (para eso hay que
 * leerlo con `pubmed_fetch_exact`); que el resumen coincida campo a campo con EFetch; ninguna cobertura.
 * Por eso el recibo dice `counts_as: titles_screened`, aparte de los abstracts obtenidos.
 *
 * QUÉ NO HACE, a propósito. No busca, no amplía la lista y no devuelve abstracts. No reintenta: cada
 * reintento del consumidor es otro intento, con su `attempt_id`.
 */

import { sha256 } from './exact-core.mjs';
import { esummary, ESUMMARY_URL, ESUMMARY_TRANSPORT, SummaryTransportError } from './esummary.mjs';
import { clip, MAX_DEPTH } from './xml-lite.mjs';
import { utf8Length } from './abstract-canonical.mjs';
import { sha256Bytes, PMID_PATTERN, MAX_PLAN_REF, MAX_STRUCTURED_BYTES, MAX_DIAGNOSTIC, PENDING_REASON } from './fetch-core.mjs';

export const SUMMARY_RECEIPT_TYPE = 'pubmed_summary_exact';
/** Versión del formato del recibo de cribado; la del contrato del router viaja en `run`. */
export const SUMMARY_RECEIPT_VERSION = '1';
/** 50 títulos caben medidos en el presupuesto (33-, §2: 295-350 B por registro); lo que no, queda pendiente. */
export const MAX_SUMMARY_PMIDS = 50;
/** Cuerpo JSON descomprimido, medido durante la lectura: 116 KB medidos para 59 registros. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const SUMMARY_TIMEOUT_MS = 30000;
export const MAX_SCREEN_ID = 40;
export const RECORD_STATUSES = ['found', 'not_found', 'error'];
export const PROVIDER = 'NCBI E-utilities ESummary (PubMed)';
/** Lo que este recibo cuenta, siempre aparte de los abstracts obtenidos y de los documentos usados. */
export const COUNTS_AS = 'titles_screened';
/** Lo único que ESummary dice de un PMID ausente, y solo eso se toma por `not_found` (medido el 26/10). */
export const NOT_FOUND_MARK = 'cannot get document summary';
const CONTEXT_KEYS = ['plan_ref', 'screen_id'];

/**
 * Claves ajenas en un diagnóstico, acotadas (revisión de Codex del lote 1.15, R3): las cinco primeras,
 * recortadas, y cuántas más hay. Una clave de 30.000 letras llevaba el rechazo a 30 KB, fuera del
 * presupuesto que la herramienta promete.
 */
export const describeKeys = (keys) => `${keys.slice(0, 5).map((k) => clip(k, 40)).join(', ')}${keys.length > 5 ? ` y ${keys.length - 5} más` : ''}`;

/**
 * La petición, antes de NCBI: 1-50 PMID en cadena, sin duplicados, sin convertir ni corregir, y el
 * contexto exacto. Devuelve el error o null.
 */
export function summaryRequestError(pmids, context) {
  if (!Array.isArray(pmids)) return 'pmids debe ser una lista de PMID en cadena';
  if (pmids.length < 1 || pmids.length > MAX_SUMMARY_PMIDS) return `pmids: entre 1 y ${MAX_SUMMARY_PMIDS} por llamada`;
  for (const [i, p] of pmids.entries()) {
    if (typeof p !== 'string' || !PMID_PATTERN.test(p)) {
      return `pmids[${i}] no es un PMID: cadena de 1 a 9 dígitos sin ceros a la izquierda; no se convierte ni se corrige`;
    }
  }
  const repeated = [...new Set(pmids.filter((p, i) => pmids.indexOf(p) !== i))];
  if (repeated.length) return `pmids repetidos: ${repeated.join(', ')}`;
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return 'context debe ser un objeto con plan_ref y screen_id';
  const extra = Object.keys(context).filter((k) => !CONTEXT_KEYS.includes(k));
  if (extra.length) return `context: claves no admitidas ${describeKeys(extra)}`;
  for (const [k, max] of [['plan_ref', MAX_PLAN_REF], ['screen_id', MAX_SCREEN_ID]]) {
    if (!Object.hasOwn(context, k)) return `context: falta ${k}`;
    if (typeof context[k] !== 'string' || context[k].trim() === '' || context[k].length > max) {
      return `context.${k}: cadena no vacía de hasta ${max} caracteres`;
    }
  }
  return null;
}

// --- JSON estricto ---------------------------------------------------------------------------------

export class JsonStrictError extends Error {}

/**
 * JSON con dos diferencias frente a `JSON.parse`, las dos de identidad: una clave repetida en un objeto
 * es un error (JSON.parse se queda con la última en silencio, y así un PMID repetido con dos registros
 * distintos pasaría por uno solo), y el anidamiento tiene tope. Las cadenas se recorren a mano, sin
 * expresiones regulares sobre texto de longitud libre. `describe` decide cómo sale una clave en el
 * diagnóstico: quien tenga secretos que ocultar los oculta ANTES de recortar.
 */
export function parseJsonStrict(text, maxDepth = MAX_DEPTH, describe = (k) => clip(k, 40)) {
  let i = 0;
  const fail = (what) => { throw new JsonStrictError(`${what} en la posición ${i}`); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  function string() {
    const start = i++;
    for (;;) {
      if (i >= text.length) fail('cadena sin cerrar');
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c < 0x20) fail('carácter de control dentro de una cadena');
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('escape \\u mal formado');
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail('escape no válido');
      } else i++;
    }
    i++;
    return JSON.parse(text.slice(start, i));
  }
  function value(depth) {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      if (depth >= maxDepth) fail('anidamiento excesivo');
      i++;
      ws();
      if (c === '[') {
        const arr = [];
        if (text[i] === ']') { i++; return arr; }
        for (;;) {
          arr.push(value(depth + 1));
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; return arr; }
          fail('se esperaba «,» o «]»');
        }
      }
      const obj = {};
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('se esperaba una clave');
        const key = string();
        if (Object.hasOwn(obj, key)) fail(`clave repetida «${describe(key)}»`);
        ws();
        if (text[i] !== ':') fail('se esperaba «:»');
        i++;
        // defineProperty y no `obj[key] =`: una clave «__proto__» es una clave, no un prototipo.
        Object.defineProperty(obj, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail('se esperaba «,» o «}»');
      }
    }
    if (c === '"') return string();
    const n = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 64));
    if (n) { i += n[0].length; return Number(n[0]); }
    for (const [lit, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(lit, i)) { i += lit.length; return v; }
    }
    return fail('valor no válido');
  }
  const out = value(0);
  ws();
  if (i !== text.length) fail('texto después del valor');
  return out;
}

// --- Del JSON al registro --------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const unique = (list) => [...new Set(list)];

/** Campos que se leen de cada resumen, con su forma. Uno ausente o con otra forma es `unsupported_record`. */
const FIELD_SHAPES = {
  uid: (v) => typeof v === 'string',
  title: (v) => typeof v === 'string',
  pubdate: (v) => typeof v === 'string',
  source: (v) => typeof v === 'string',
  doctype: (v) => typeof v === 'string',
  pubtype: isStrList,
  attributes: isStrList,
  articleids: (v) => Array.isArray(v) && v.every((a) => isObj(a) && typeof a.idtype === 'string' && typeof a.value === 'string'),
};

const errorRecord = (pmid, reason, detail = null, returned = null, extra = {}) => ({
  requested_pmid: pmid, returned_pmid: returned, record_status: 'error', reason, detail: detail === null ? null : clip(detail, MAX_DIAGNOSTIC), ...extra,
});
const notFound = (pmid) => ({ requested_pmid: pmid, returned_pmid: null, record_status: 'not_found', reason: null, detail: null });

/**
 * Un resumen ya atribuido a `pmid` por su clave y su `uid`. `year` sale de `pubdate` si trae un solo año;
 * si es ambiguo, se conserva el texto y `year` es null. El título no se corta ni se limpia: puede diferir
 * en formato del de EFetch. Un libro sin título de capítulo lleva el del libro en `book_title`, aparte.
 */
function extractRecord(entry, pmid) {
  const bad = Object.keys(FIELD_SHAPES).filter((k) => !Object.hasOwn(entry, k) || !FIELD_SHAPES[k](entry[k]));
  if (Object.hasOwn(entry, 'booktitle') && typeof entry.booktitle !== 'string') bad.push('booktitle');
  if (bad.length) return errorRecord(pmid, 'unsupported_record', `campos ausentes o con otra forma: ${bad.join(', ')}`, pmid);
  const years = unique(entry.pubdate.match(/\b[0-9]{4}\b/g) ?? []);
  return {
    requested_pmid: pmid,
    returned_pmid: pmid,
    record_status: 'found',
    reason: null,
    record_type: entry.doctype,
    title: entry.title === '' ? null : entry.title,
    book_title: typeof entry.booktitle === 'string' && entry.booktitle !== '' ? entry.booktitle : null,
    pubdate: entry.pubdate,
    year: years.length === 1 ? Number(years[0]) : null,
    journal: entry.source === '' ? null : entry.source,
    publication_types: entry.pubtype,
    dois: unique(entry.articleids.filter((a) => a.idtype === 'doi').map((a) => a.value)),
    has_abstract: entry.attributes.includes('Has Abstract'),
  };
}

const TOP_KEYS = ['header', 'result'];

/**
 * Del cuerpo completo a un resultado por PMID pedido (clases 2, 5, 6 y 7 de 32- §5). Primero lo global:
 * codificación, JSON estricto, un error de NCBI en cualquier sitio de la cabecera (antes de atribuir nada)
 * y la forma. Después, la identidad de la respuesta entera: `uids` sin repetir ni ajenos, y una entrada
 * por uid y ninguna más. Solo entonces cada PMID: su `uid` tiene que ser él; la marca exacta de NCBI es
 * `not_found`; un PMID del que NCBI no dice nada es `absent_from_response`, nunca `not_found`.
 *
 * Todo texto que viene de la respuesta y acaba en un diagnóstico pasa por `diag`: primero `clean` (que
 * oculta la clave y el contacto) y después el recorte, para que un recorte no deje a la vista medio
 * secreto (revisión de Codex del lote 1.15, R2: la vía de error de cada registro no ocultaba nada).
 */
function interpret(bytes, pmids, clean = (t) => t) {
  const diag = (text, max = MAX_DIAGNOSTIC) => clip(clean(String(text)), max);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { failure: { code: 'invalid_encoding', message: 'el cuerpo no es UTF-8 válido' } };
  }
  let doc;
  try {
    doc = parseJsonStrict(text, MAX_DEPTH, (k) => diag(k, 40));
  } catch (e) {
    if (!(e instanceof JsonStrictError)) throw e;
    return { failure: { code: 'invalid_json', message: diag(e.message) } };
  }
  if (!isObj(doc)) return { failure: { code: 'unexpected_shape', message: 'la respuesta no es un objeto JSON' } };
  // Un error global de NCBI invalida la respuesta entera ANTES de atribuir registros (revisión de Codex, R6).
  const globalErrors = ['error', 'esummaryresult'].filter((k) => Object.hasOwn(doc, k))
    .concat(isObj(doc.result) && Object.hasOwn(doc.result, 'error') ? ['result.error'] : []);
  if (globalErrors.length) {
    const said = globalErrors.map((k) => diag(JSON.stringify(k === 'result.error' ? doc.result.error : doc[k]), 200)).join(' | ');
    return { failure: { code: 'ncbi_error', message: clip(`NCBI devolvió un error global: ${said}`, MAX_DIAGNOSTIC) } };
  }
  const extraTop = Object.keys(doc).filter((k) => !TOP_KEYS.includes(k));
  if (extraTop.length || doc.header?.type !== 'esummary' || !isObj(doc.result)) {
    return { failure: { code: 'unexpected_shape', message: diag(`no es una respuesta ESummary: cabecera ${JSON.stringify(doc.header?.type ?? null)}`
      + `${extraTop.length ? `, claves ${extraTop.join(', ')}` : ''}${isObj(doc.result) ? '' : ', sin result'}`) } };
  }
  const { uids } = doc.result;
  const requested = new Set(pmids);
  const identity = [];
  if (!isStrList(uids)) identity.push('result.uids no es una lista de cadenas');
  else {
    const repeated = unique(uids.filter((u, k) => uids.indexOf(u) !== k));
    if (repeated.length) identity.push(`uid repetido: ${repeated.map((u) => diag(u, 20)).join(', ')}`);
    const foreign = uids.filter((u) => !requested.has(u));
    if (foreign.length) identity.push(`registro no pedido: ${foreign.map((u) => diag(u, 20)).join(', ')}`);
    const entries = Object.keys(doc.result).filter((k) => k !== 'uids');
    const orphan = entries.filter((k) => !uids.includes(k));
    if (orphan.length) identity.push(`entrada sin uid en la lista: ${orphan.map((k) => diag(k, 20)).join(', ')}`);
    const unlisted = uids.filter((u) => !Object.hasOwn(doc.result, u));
    if (unlisted.length) identity.push(`uid sin entrada: ${unlisted.join(', ')}`);
    // Identidad dentro de cada resumen (revisión de Codex del lote 1.15, R4): clave y uid pueden coincidir y
    // articleids nombrar otro PMID. Esa contradicción no se aísla en un registro: con ella, la respuesta
    // entera deja de certificar a quién pertenece cada resumen. Si no hay articleids de tipo pubmed, no se exige.
    for (const u of uids.filter((x) => isObj(doc.result[x]) && Array.isArray(doc.result[x].articleids))) {
      const other = doc.result[u].articleids.filter((a) => isObj(a) && a.idtype === 'pubmed' && a.value !== u);
      if (other.length) {
        identity.push(`la entrada ${diag(u, 20)} dice PMID ${other.map((a) => diag(JSON.stringify(a.value), 20)).join(', ')} en articleids`);
      }
    }
  }
  if (identity.length) {
    return { failure: { code: 'identity_uncertain', message: clip(`no se puede certificar la correspondencia: ${identity.join('; ')}`, MAX_DIAGNOSTIC) } };
  }
  const results = new Map();
  for (const pmid of pmids) {
    if (!uids.includes(pmid)) {
      results.set(pmid, errorRecord(pmid, 'absent_from_response', 'ESummary no devolvió ni registro ni error para este PMID'));
      continue;
    }
    const entry = doc.result[pmid];
    if (!isObj(entry)) { results.set(pmid, errorRecord(pmid, 'unsupported_record', 'la entrada no es un objeto')); continue; }
    if (entry.uid !== pmid) {
      const returned = typeof entry.uid === 'string' && PMID_PATTERN.test(entry.uid) ? entry.uid : null;
      results.set(pmid, errorRecord(pmid, 'pmid_mismatch', `la entrada de ${pmid} dice uid ${diag(JSON.stringify(entry.uid ?? null), 40)}`, returned));
      continue;
    }
    if (Object.hasOwn(entry, 'error')) {
      const exact = entry.error === NOT_FOUND_MARK && Object.keys(entry).length === 2;
      results.set(pmid, exact ? notFound(pmid) : errorRecord(pmid, 'ncbi_record_error', diag(`NCBI: ${JSON.stringify(entry.error)}`), pmid));
      continue;
    }
    results.set(pmid, extractRecord(entry, pmid));
  }
  const problems = [];
  const missing = pmids.filter((p) => results.get(p).record_status === 'not_found');
  if (missing.length && pmids.length > 1) {
    problems.push(`no encontrados en esta respuesta ESummary: ${missing.join(', ')}; no prueba que no existan: pídelos solos`);
  }
  return { identity: 'verified', results, problems };
}

// --- El recibo -------------------------------------------------------------------------------------

const jsonBytes = (obj) => utf8Length(JSON.stringify(obj));
const isContent = (r) => r.record_status === 'found';

async function envelope(pmids, context, o) {
  const ctx = { plan_ref: context.plan_ref, screen_id: context.screen_id };
  return {
    run: o.run ?? null,
    attempt_id: o.attemptId ?? globalThis.crypto.randomUUID(),
    received_at: o.receivedAt ?? o.now().toISOString(),
    executed_at: null,
    completed_at: null,
    engine: o.engine,
    request: {
      pmids: [...pmids], context: ctx, context_sha256: await sha256(JSON.stringify(ctx)), declared_by: 'agent',
      api_key_used: Boolean(o.apiKey), email_used: Boolean(o.email),
    },
    limits: { max_pmids: MAX_SUMMARY_PMIDS, structured_content_max_bytes: o.maxStructuredBytes,
      response_max_bytes: o.maxJsonBytes, timeout_ms: o.timeoutMs },
  };
}

/** El recibo en su orden de claves; `delivery` se deriva de lo que va dentro, nunca se declara aparte. */
function assemble(env, { transport, failure = null, identity, problems, pmids = env.request.pmids, results, pending }) {
  const delivery = failure || identity === 'failed' ? 'failed'
    : pending.length || results.some((r) => r.record_status === 'error') ? 'partial' : 'complete';
  return {
    run: env.run,
    receipt_type: SUMMARY_RECEIPT_TYPE,
    receipt_version: SUMMARY_RECEIPT_VERSION,
    counts_as: COUNTS_AS,
    attempt_id: env.attempt_id,
    received_at: env.received_at,
    executed_at: env.executed_at,
    completed_at: env.completed_at,
    engine: env.engine,
    provider: PROVIDER,
    endpoint: ESUMMARY_URL,
    request: { ...env.request, pmids },
    transport,
    limits: env.limits,
    failure,
    status: { record_identity: identity, delivery },
    pending_pmids: pending,
    problems,
    results,
  };
}

/**
 * Presupuesto de salida, con la regla de la lectura (29-, §3.6): primero, los registros que no caben
 * SOLOS pasan a `record_too_large` con su tamaño; luego, en el orden pedido, entra cada registro completo
 * que quepa reservando sitio para errores y pendientes; el que no cabe va a `pending_pmids`. Un título
 * nunca se corta.
 */
function fitToBudget(env, parts, records, max) {
  const pmids = env.request.pmids;
  for (const pmid of pmids) {
    const r = records.get(pmid);
    if (!isContent(r)) continue;
    const alone = jsonBytes(assemble(env, { ...parts, pmids: [pmid], results: [r], pending: [] }));
    if (alone > max) {
      const recordBytes = jsonBytes(r);
      records.set(pmid, errorRecord(pmid, 'record_too_large',
        `el resumen completo ocupa ${recordBytes} bytes y, con la envoltura mínima del recibo, no cabe en ${max}`,
        r.returned_pmid, { record_bytes: recordBytes, max_record_bytes: max - (alone - recordBytes) }));
    }
  }
  const content = pmids.filter((p) => isContent(records.get(p)));
  const delivered = new Set(pmids.filter((p) => !isContent(records.get(p))));
  const pending = new Set();
  const build = (pend) => assemble(env, { ...parts,
    results: pmids.filter((p) => delivered.has(p)).map((p) => records.get(p)),
    pending: pmids.filter((p) => pend.has(p)).map((p) => ({ pmid: p, reason: PENDING_REASON })) });
  // Con 50 registros, medir el recibo entero en cada paso son 50 serializaciones; basta con sumar. Se
  // parte de todos pendientes (la reserva de la lectura) y cada paso mueve uno de una lista a la otra:
  // su JSON y, si la lista no queda o no estaba vacía, una coma.
  let size = jsonBytes(build(new Set(content)));
  let inResults = delivered.size;
  let inPending = content.length;
  for (const p of content) {
    const delta = jsonBytes(records.get(p)) + (inResults > 0 ? 1 : 0)
      - jsonBytes({ pmid: p, reason: PENDING_REASON }) - (inPending > 1 ? 1 : 0);
    if (size + delta <= max) {
      delivered.add(p);
      size += delta;
      inResults++;
      inPending--;
    } else {
      pending.add(p);
    }
  }
  let receipt = build(pending);
  // Defensa: si la suma se quedara corta frente al recibo real, sale otro pendiente, desde el final.
  while (jsonBytes(receipt) > max) {
    const last = content.filter((p) => delivered.has(p)).at(-1);
    if (last === undefined) return null; // ni sin registros cabe: lo resuelve bounded() con un fallo compacto
    delivered.delete(last);
    pending.add(last);
    receipt = build(pending);
  }
  return receipt;
}

/**
 * Última defensa del presupuesto: ninguna salida, tampoco la de un fallo, lo supera ni escapa como
 * excepción. Si no cabe, un fallo compacto explícito, sin ningún registro.
 */
function bounded(env, receipt, transport, max) {
  if (receipt && jsonBytes(receipt) <= max) return receipt;
  const message = `el recibo no cabía en ${max} bytes ni sin registros: no se entrega ninguno`;
  return assemble(env, { transport, failure: { code: 'receipt_too_large', message }, identity: 'failed', problems: [message],
    results: env.request.pmids.map((p) => errorRecord(p, 'receipt_too_large')), pending: [] });
}

const options = (o) => ({
  run: null, apiKey: '', email: '', tool: 'pubmed-filters-exact', engine: 'scripts/summary-core.mjs',
  timeoutMs: SUMMARY_TIMEOUT_MS, maxJsonBytes: MAX_JSON_BYTES, maxStructuredBytes: MAX_STRUCTURED_BYTES,
  now: () => new Date(), ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)),
});

const redact = (text, o) => [o.apiKey, o.email].filter(Boolean).reduce((t, secret) => t.split(secret).join('[oculto]'), String(text));

/**
 * Recibo de un intento que no produjo una respuesta utilizable (transporte, tamaño, tiempo, cola,
 * codificación, JSON o identidad): todos los PMID pedidos salen `error` con ese motivo, nunca ausentes.
 */
export async function summaryFailureReceipt(pmids, context, opts, { code, message, httpStatus = null, bytesReceived = null, env: given }) {
  const o = options(opts);
  const env = given ?? await envelope(pmids, context, o);
  env.completed_at = o.now().toISOString();
  const safe = redact(message, o);
  const transport = { method: ESUMMARY_TRANSPORT, http_status: httpStatus, bytes_received: bytesReceived, raw_response_sha256: null };
  return bounded(env, assemble(env, {
    transport,
    failure: { code, message: safe },
    identity: 'failed',
    problems: [safe],
    results: pmids.map((p) => errorRecord(p, code)),
    pending: [],
  }), transport, o.maxStructuredBytes);
}

/**
 * Criba `pmids` (1-50) con su `context` y devuelve el recibo. Lanza solo si la petición no es válida, que
 * se comprueba antes de NCBI; cualquier fallo después es un recibo con `status.delivery: failed`.
 */
export async function runSummary(pmids, context, opts = {}) {
  const invalid = summaryRequestError(pmids, context);
  if (invalid) throw new Error(invalid);
  const o = options(opts);
  const env = await envelope(pmids, context, o);
  env.executed_at = o.now().toISOString();
  let response;
  try {
    response = await esummary(pmids, {
      params: { tool: o.tool, ...(o.email ? { email: o.email } : {}), ...(o.apiKey ? { api_key: o.apiKey } : {}) },
      signal: AbortSignal.timeout(o.timeoutMs), maxBytes: o.maxJsonBytes, ...(o.fetcher ? { fetcher: o.fetcher } : {}),
    });
  } catch (e) {
    const t = e instanceof SummaryTransportError ? e : new SummaryTransportError('network', 'fallo inesperado de la petición');
    return summaryFailureReceipt(pmids, context, o, { env, code: t.code, message: t.message, httpStatus: t.httpStatus, bytesReceived: t.bytesReceived });
  }
  const transport = { method: ESUMMARY_TRANSPORT, http_status: response.httpStatus, bytes_received: response.bytes.byteLength,
    raw_response_sha256: await sha256Bytes(response.bytes) };
  const read = interpret(response.bytes, pmids, (t) => redact(t, o));
  env.completed_at = o.now().toISOString();
  if (read.failure) {
    const safe = redact(read.failure.message, o);
    return bounded(env, assemble(env, { transport, failure: { code: read.failure.code, message: safe }, identity: 'failed',
      problems: [safe], results: pmids.map((p) => errorRecord(p, read.failure.code)), pending: [] }), transport, o.maxStructuredBytes);
  }
  return bounded(env, fitToBudget(env, { transport, identity: read.identity, problems: read.problems }, read.results, o.maxStructuredBytes),
    transport, o.maxStructuredBytes);
}
