/**
 * Núcleo de la lectura con recibo, `pubmed_fetch_exact` (especificación 29- con la adenda de Codex del
 * 24/10/2026). Hermano de `exact-core.mjs` y, como él, código PURO (fetch, Web Crypto, sin disco): lo
 * comparten el CLI (`pubmed-fetch-exact.mjs`), el MCP local y el Worker. Tres superficies, un juicio.
 *
 * QUÉ ACREDITA. Qué se pidió, qué devolvió NCBI y qué se entregó: cada PMID pedido sale como registro
 * completo, como pendiente explícito o como error con motivo; nunca cortado, sustituido ni asociado por
 * posición. QUÉ NO: que alguien lo leyera, lo entendiera o lo trasladara a una respuesta
 * (surface_policy_not_owned_here). Ni `run`, ni `attempt_id`, ni las huellas son firmas: identifican.
 *
 * QUÉ NO HACE, a propósito. No busca, no amplía la lista, no sigue referencias ni cambia un PMID por un
 * DOI, un título o un PMID contiguo. No continúa un registro por tramos: el que no cabe solo es
 * `record_too_large` (sin continuación en v1, R2). No lee texto completo de PMC. No reintenta: cada
 * reintento del consumidor es otro intento, con su `attempt_id`.
 */

import { sha256 } from './exact-core.mjs';
import { efetch, EFETCH_URL, EFETCH_TRANSPORT, FetchTransportError } from './efetch.mjs';
import { parseXml, childNamed, childrenNamed } from './xml-lite.mjs';
import { ABSTRACT_FORMAT, canonicalAbstract, hasAbstractText, utf8Length } from './abstract-canonical.mjs';

export const FETCH_RECEIPT_TYPE = 'pubmed_fetch_exact';
/** Versión del formato del recibo de lectura; la del contrato del router viaja en `run`. */
export const FETCH_RECEIPT_VERSION = '1';
export const MAX_FETCH_PMIDS = 5;
/** Presupuesto del objeto estructurado, JSON compacto en bytes UTF-8 (29-, §2 y §3.6). */
export const MAX_STRUCTURED_BYTES = 24 * 1024;
/** Cuerpo XML descomprimido, medido durante la lectura (29-, §3.2). */
export const MAX_XML_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30000;
export const MAX_PLAN_REF = 80;
export const MAX_READ_ID = 40;
export const PMID_PATTERN = /^[1-9][0-9]{0,8}$/;
export const RECORD_STATUSES = ['with_abstract', 'without_abstract', 'not_found', 'error'];
export const PENDING_REASON = 'response_size_limit';
export const PROVIDER = 'NCBI E-utilities EFetch (PubMed)';
const CONTEXT_KEYS = ['plan_ref', 'read_id'];

/** SHA-256 de unos bytes, con Web Crypto (Node y Workers). */
export async function sha256Bytes(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * La petición, antes de NCBI: 1-5 PMID en cadena, sin duplicados, sin convertir ni corregir (un número,
 * un cero a la izquierda o un espacio se rechazan), y el contexto exacto. Devuelve el error o null.
 */
export function fetchRequestError(pmids, context) {
  if (!Array.isArray(pmids)) return 'pmids debe ser una lista de PMID en cadena';
  if (pmids.length < 1 || pmids.length > MAX_FETCH_PMIDS) return `pmids: entre 1 y ${MAX_FETCH_PMIDS} por llamada`;
  for (const [i, p] of pmids.entries()) {
    if (typeof p !== 'string' || !PMID_PATTERN.test(p)) {
      return `pmids[${i}] no es un PMID: cadena de 1 a 9 dígitos sin ceros a la izquierda; no se convierte ni se corrige`;
    }
  }
  const repeated = [...new Set(pmids.filter((p, i) => pmids.indexOf(p) !== i))];
  if (repeated.length) return `pmids repetidos: ${repeated.join(', ')}`;
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return 'context debe ser un objeto con plan_ref y read_id';
  const extra = Object.keys(context).filter((k) => !CONTEXT_KEYS.includes(k));
  if (extra.length) return `context: claves no admitidas ${extra.join(', ')}`;
  for (const [k, max] of [['plan_ref', MAX_PLAN_REF], ['read_id', MAX_READ_ID]]) {
    if (!Object.hasOwn(context, k)) return `context: falta ${k}`;
    if (typeof context[k] !== 'string' || context[k].trim() === '' || context[k].length > max) {
      return `context.${k}: cadena no vacía de hasta ${max} caracteres`;
    }
  }
  return null;
}

// --- Del XML al registro ---------------------------------------------------------------------------

/** Un defecto de UN registro: no rompe la respuesta, pero ese PMID sale como `error` con su motivo. */
class RecordError extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
    this.detail = detail;
  }
}

const lf = (text) => text.replace(/\r\n?/g, '\n');
const PASS_THROUGH = new Set(['b', 'i', 'u']);

/**
 * Contenido mixto (29-, §3.5.2): negrita, cursiva y subrayado conservan su texto; superíndice y
 * subíndice se escriben `^(...)` y `_(...)`. Cualquier otro nodo (MathML, fórmulas) es un error del
 * registro con `reason`: nada se elimina en silencio.
 */
function markupText(el, reason) {
  let out = '';
  for (const c of el.children) {
    if (typeof c === 'string') out += c;
    else if (PASS_THROUGH.has(c.name)) out += markupText(c, reason);
    else if (c.name === 'sup') out += `^(${markupText(c, reason)})`;
    else if (c.name === 'sub') out += `_(${markupText(c, reason)})`;
    else throw new RecordError(reason, `<${c.name}> dentro de <${el.name}> no se puede representar sin pérdida`);
  }
  return lf(out);
}

/** Texto sin marcado: identificadores, fechas, tipos. Un elemento dentro es un error, no se ignora. */
function plainText(el) {
  for (const c of el.children) {
    if (typeof c !== 'string') throw new RecordError('unsupported_markup', `<${c.name}> dentro de <${el.name}>`);
  }
  return lf(el.children.join(''));
}

/** Un solo hijo; repetido es un formato que no se sabe leer, no se elige uno. */
function one(el, name) {
  try {
    return childNamed(el, name);
  } catch (e) {
    throw new RecordError('unsupported_record', e.message);
  }
}

const unique = (list) => [...new Set(list)];

/** El PMID de un registro soportado, de su sitio y solo de él: nunca el de una referencia citada. */
function pmidOf(el) {
  try {
    const holder = one(el, el.name === 'PubmedBookArticle' ? 'BookDocument' : 'MedlineCitation');
    const p = one(holder, 'PMID');
    const text = p ? plainText(p) : null;
    return text !== null && PMID_PATTERN.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** PMID de un elemento que no se sabe leer: solo se le atribuye si contiene exactamente uno. */
function descendantPmids(el, out = new Set()) {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.name === 'PMID' && c.children.every((x) => typeof x === 'string')) out.add(c.children.join(''));
    descendantPmids(c, out);
  }
  return out;
}

const PUB_DATE_PARTS = { Year: 'year', Month: 'month', Day: 'day', Season: 'season', MedlineDate: 'medline_date' };

/**
 * Fecha de publicación del número (o del libro) con su origen. `year` sale de `Year`, o de una
 * `MedlineDate` con un solo año; si es ambigua, se conserva el texto y `year` es null. Nunca la fecha de
 * creación o revisión del registro.
 */
function pubDate(el, source) {
  if (!el) return { publication_date: null, year: null };
  const d = { source, year: null, month: null, day: null, season: null, medline_date: null };
  for (const c of el.children) {
    if (typeof c === 'string') {
      if (/\S/.test(c)) throw new RecordError('unsupported_markup', 'texto suelto en PubDate');
      continue;
    }
    const key = PUB_DATE_PARTS[c.name];
    if (!key || d[key] !== null) throw new RecordError('unsupported_markup', `<${c.name}> no esperado en PubDate`);
    d[key] = plainText(c);
  }
  let year = null;
  if (d.year !== null) year = /^[0-9]{4}$/.test(d.year) ? Number(d.year) : null;
  else if (d.medline_date !== null) {
    const years = unique(d.medline_date.match(/\b[0-9]{4}\b/g) ?? []);
    year = years.length === 1 ? Number(years[0]) : null;
  }
  return { publication_date: d, year };
}

/** Un bloque de abstract (principal u OtherAbstract), o null si no tiene ninguna sección. */
function abstractBlock(el, kind) {
  const sections = [];
  let copyright = null;
  for (const c of el.children) {
    if (typeof c === 'string') {
      if (/\S/.test(c)) throw new RecordError('unsupported_abstract_content', `texto fuera de AbstractText en <${el.name}>`);
      continue;
    }
    if (c.name === 'AbstractText') {
      sections.push({ label: c.attrs.Label ?? null, nlm_category: c.attrs.NlmCategory ?? null,
        text: markupText(c, 'unsupported_abstract_content') });
    } else if (c.name === 'CopyrightInformation' && copyright === null) {
      copyright = markupText(c, 'unsupported_abstract_content');
    } else {
      throw new RecordError('unsupported_abstract_content', `<${c.name}> dentro de <${el.name}>`);
    }
  }
  if (sections.length === 0) return null;
  const other = kind === 'other_abstract';
  return { kind, language: other ? el.attrs.Language ?? null : null, type: other ? el.attrs.Type ?? null : null, sections, copyright };
}

/** Registro completo de un PubmedArticle o PubmedBookArticle ya atribuido a `pmid`. */
async function extractRecord(el, pmid) {
  const book = el.name === 'PubmedBookArticle';
  const holder = one(el, book ? 'BookDocument' : 'MedlineCitation');
  const article = book ? holder : one(holder, 'Article');
  if (!article) throw new RecordError('unsupported_record', 'MedlineCitation sin Article');
  const ids = childrenNamed(one(one(el, book ? 'PubmedBookData' : 'PubmedData'), 'ArticleIdList'), 'ArticleId');
  const titleEl = one(article, 'ArticleTitle') ?? (book ? one(one(holder, 'Book'), 'BookTitle') : null);
  const dateEl = book ? one(one(holder, 'Book'), 'PubDate') : one(one(one(article, 'Journal'), 'JournalIssue'), 'PubDate');
  const { publication_date, year } = pubDate(dateEl,
    book ? 'BookDocument/Book/PubDate' : 'MedlineCitation/Article/Journal/JournalIssue/PubDate');
  const record = {
    requested_pmid: pmid,
    returned_pmid: pmid,
    record_status: null,
    reason: null,
    record_type: el.name,
    title: titleEl ? markupText(titleEl, 'unsupported_markup') : null,
    dois: unique([
      ...childrenNamed(article, 'ELocationID').filter((e) => e.attrs.EIdType === 'doi').map(plainText),
      ...ids.filter((a) => a.attrs.IdType === 'doi').map(plainText),
    ]),
    pmcids: unique(ids.filter((a) => a.attrs.IdType === 'pmc').map(plainText)),
    publication_date,
    year,
    publication_types: (book ? childrenNamed(holder, 'PublicationType')
      : childrenNamed(one(article, 'PublicationTypeList'), 'PublicationType')).map(plainText),
  };
  const main = one(article, 'Abstract');
  const blocks = [main && abstractBlock(main, 'abstract'),
    ...childrenNamed(holder, 'OtherAbstract').map((o) => abstractBlock(o, 'other_abstract'))].filter(Boolean);
  if (!hasAbstractText(blocks)) {
    return { ...record, record_status: 'without_abstract', abstract_format: null, abstract_bytes: null, abstract_sha256: null, abstract_canonical: null };
  }
  const canonical = canonicalAbstract(blocks);
  return { ...record, record_status: 'with_abstract', abstract_format: ABSTRACT_FORMAT,
    abstract_bytes: utf8Length(canonical), abstract_sha256: await sha256(canonical), abstract_canonical: canonical };
}

const errorRecord = (pmid, reason, detail = null, returned = null, extra = {}) => ({
  requested_pmid: pmid, returned_pmid: returned, record_status: 'error', reason, detail, ...extra,
});
const notFound = (pmid) => ({ requested_pmid: pmid, returned_pmid: null, record_status: 'not_found', reason: null, detail: null });

/**
 * Del cuerpo completo a un resultado por PMID pedido. La ausencia solo se decide tras recorrer TODO el
 * XML; una raíz inesperada, un registro no pedido, uno repetido o uno soportado sin PMID legible impiden
 * certificar la correspondencia de la respuesta entera (`failure`). Un elemento desconocido deja la
 * identidad en `unsupported`: si se le puede atribuir un PMID, ese sale `unsupported_record`; si no, los
 * PMID que falten salen `identity_uncertain`, nunca `not_found`.
 */
async function interpret(bytes, pmids) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { failure: { code: 'invalid_encoding', message: 'el cuerpo no es UTF-8 válido' } };
  }
  let doc;
  try {
    doc = parseXml(text);
  } catch (e) {
    return { failure: { code: 'invalid_xml', message: e.message } };
  }
  if (doc.root.name !== 'PubmedArticleSet') {
    return { failure: { code: 'unexpected_root', message: `raíz <${doc.root.name}>, no <PubmedArticleSet>` } };
  }
  const requested = new Set(pmids);
  const found = new Map();
  const identity = [];
  const unknownUnattributed = [];
  let unknown = false;
  for (const c of doc.root.children) {
    if (typeof c === 'string') {
      if (/\S/.test(c)) identity.push('texto suelto dentro de <PubmedArticleSet>');
      continue;
    }
    const supported = c.name === 'PubmedArticle' || c.name === 'PubmedBookArticle';
    let pmid = null;
    if (supported) {
      pmid = pmidOf(c);
      if (pmid === null) { identity.push(`<${c.name}> sin PMID legible`); continue; }
    } else {
      unknown = true;
      const inside = descendantPmids(c);
      if (inside.size !== 1) { unknownUnattributed.push(c.name); continue; }
      [pmid] = inside;
    }
    if (!requested.has(pmid)) identity.push(`registro no pedido: PMID ${pmid}`);
    else if (found.has(pmid)) identity.push(`PMID ${pmid} repetido en la respuesta`);
    else found.set(pmid, { el: c, supported });
  }
  if (identity.length) {
    return { failure: { code: 'identity_uncertain', message: `no se puede certificar la correspondencia: ${identity.join('; ')}` } };
  }
  const results = new Map();
  const problems = [];
  for (const pmid of pmids) {
    const f = found.get(pmid);
    if (!f) {
      results.set(pmid, unknownUnattributed.length
        ? errorRecord(pmid, 'identity_uncertain', `la respuesta trae elementos no soportados sin PMID atribuible (${unique(unknownUnattributed).join(', ')})`)
        : notFound(pmid));
    } else if (!f.supported) {
      results.set(pmid, errorRecord(pmid, 'unsupported_record', `<${f.el.name}> no es un formato soportado`, pmid));
    } else {
      try {
        results.set(pmid, await extractRecord(f.el, pmid));
      } catch (e) {
        if (!(e instanceof RecordError)) throw e;
        results.set(pmid, errorRecord(pmid, e.reason, e.detail, pmid));
      }
    }
  }
  const missing = pmids.filter((p) => results.get(p).record_status === 'not_found');
  if (missing.length && pmids.length > 1) {
    problems.push(`no encontrados en esta respuesta EFetch: ${missing.join(', ')}; no prueba que no existan: pídelos solos`);
  }
  return { identity: unknown ? 'unsupported' : 'verified', results, problems };
}

// --- El recibo -------------------------------------------------------------------------------------

const jsonBytes = (obj) => utf8Length(JSON.stringify(obj));
const isContent = (r) => r.record_status === 'with_abstract' || r.record_status === 'without_abstract';

async function envelope(pmids, context, o) {
  const ctx = { plan_ref: context.plan_ref, read_id: context.read_id };
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
    limits: { max_pmids: MAX_FETCH_PMIDS, structured_content_max_bytes: o.maxStructuredBytes,
      response_max_bytes: o.maxXmlBytes, timeout_ms: o.timeoutMs },
  };
}

/** El recibo en su orden de claves; `delivery` se deriva de lo que va dentro, nunca se declara aparte. */
function assemble(env, { transport, failure = null, identity, problems, pmids = env.request.pmids, results, pending }) {
  const delivery = failure || identity === 'failed' ? 'failed'
    : pending.length || results.some((r) => r.record_status === 'error') ? 'partial' : 'complete';
  return {
    run: env.run,
    receipt_type: FETCH_RECEIPT_TYPE,
    receipt_version: FETCH_RECEIPT_VERSION,
    attempt_id: env.attempt_id,
    received_at: env.received_at,
    executed_at: env.executed_at,
    completed_at: env.completed_at,
    engine: env.engine,
    provider: PROVIDER,
    endpoint: EFETCH_URL,
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
 * Presupuesto de salida (29-, §3.6, R1 aceptado). Primero, los registros que no caben SOLOS —con la
 * envoltura que tendría una petición de ese único PMID— pasan a `record_too_large` con su tamaño. Luego,
 * en el orden pedido, entra cada registro completo que quepa reservando sitio para errores y pendientes;
 * el que no cabe en lo que queda va a `pending_pmids`. Nada se corta.
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
        `el registro completo ocupa ${recordBytes} bytes y, con la envoltura mínima del recibo, no cabe en ${max}`,
        r.returned_pmid, { record_bytes: recordBytes, max_record_bytes: max - (alone - recordBytes) }));
    }
  }
  const content = pmids.filter((p) => isContent(records.get(p)));
  const delivered = new Set(pmids.filter((p) => !isContent(records.get(p))));
  const pending = new Set();
  const build = (pend) => assemble(env, { ...parts,
    results: pmids.filter((p) => delivered.has(p)).map((p) => records.get(p)),
    pending: pmids.filter((p) => pend.has(p)).map((p) => ({ pmid: p, reason: PENDING_REASON })) });
  content.forEach((p, k) => {
    delivered.add(p);
    if (jsonBytes(build(new Set([...pending, ...content.slice(k + 1)]))) > max) {
      delivered.delete(p);
      pending.add(p);
    }
  });
  let receipt = build(pending);
  // Defensa: la prueba de cada paso ya mide la configuración final; si no cupiera, sale otro pendiente.
  while (jsonBytes(receipt) > max) {
    const last = content.filter((p) => delivered.has(p)).at(-1);
    if (last === undefined) throw new Error('la envoltura del recibo no cabe en su presupuesto');
    delivered.delete(last);
    pending.add(last);
    receipt = build(pending);
  }
  return receipt;
}

const options = (o) => ({
  run: null, apiKey: '', email: '', tool: 'pubmed-filters-exact', engine: 'scripts/pubmed-fetch-exact.mjs',
  timeoutMs: FETCH_TIMEOUT_MS, maxXmlBytes: MAX_XML_BYTES, maxStructuredBytes: MAX_STRUCTURED_BYTES,
  now: () => new Date(), ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)),
});

const redact = (text, o) => [o.apiKey, o.email].filter(Boolean).reduce((t, secret) => t.split(secret).join('[oculto]'), String(text));

/**
 * Recibo de un intento que no produjo una respuesta utilizable (transporte, tamaño, tiempo, cola,
 * codificación, XML o identidad): todos los PMID pedidos salen `error` con ese motivo, nunca ausentes.
 */
export async function fetchFailureReceipt(pmids, context, opts, { code, message, httpStatus = null, bytesReceived = null, executedAt = null, env: given }) {
  const o = options(opts);
  const env = given ?? await envelope(pmids, context, o);
  env.executed_at = executedAt ?? env.executed_at;
  env.completed_at = o.now().toISOString();
  const safe = redact(message, o);
  return assemble(env, {
    transport: { method: EFETCH_TRANSPORT, http_status: httpStatus, bytes_received: bytesReceived, raw_response_sha256: null },
    failure: { code, message: safe },
    identity: 'failed',
    problems: [safe],
    results: pmids.map((p) => errorRecord(p, code)),
    pending: [],
  });
}

/**
 * Lee `pmids` (1-5) con su `context` y devuelve el recibo. Lanza solo si la petición no es válida, que
 * se comprueba antes de NCBI; cualquier fallo después es un recibo con `status.delivery: failed`.
 */
export async function runFetch(pmids, context, opts = {}) {
  const invalid = fetchRequestError(pmids, context);
  if (invalid) throw new Error(invalid);
  const o = options(opts);
  const env = await envelope(pmids, context, o);
  env.executed_at = o.now().toISOString();
  let response;
  try {
    response = await efetch(pmids, {
      params: { tool: o.tool, ...(o.email ? { email: o.email } : {}), ...(o.apiKey ? { api_key: o.apiKey } : {}) },
      signal: AbortSignal.timeout(o.timeoutMs), maxBytes: o.maxXmlBytes, ...(o.fetcher ? { fetcher: o.fetcher } : {}),
    });
  } catch (e) {
    const t = e instanceof FetchTransportError ? e : new FetchTransportError('network', 'fallo inesperado de la petición');
    return fetchFailureReceipt(pmids, context, o, { env, code: t.code, message: t.message, httpStatus: t.httpStatus, bytesReceived: t.bytesReceived });
  }
  const transport = { method: EFETCH_TRANSPORT, http_status: response.httpStatus, bytes_received: response.bytes.byteLength,
    raw_response_sha256: await sha256Bytes(response.bytes) };
  const read = await interpret(response.bytes, pmids);
  env.completed_at = o.now().toISOString();
  if (read.failure) {
    const safe = redact(read.failure.message, o);
    return assemble(env, { transport, failure: { code: read.failure.code, message: safe }, identity: 'failed',
      problems: [safe], results: pmids.map((p) => errorRecord(p, read.failure.code)), pending: [] });
  }
  return fitToBudget(env, { transport, identity: read.identity, problems: read.problems }, read.results, o.maxStructuredBytes);
}
