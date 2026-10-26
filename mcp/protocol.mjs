/**
 * Servidor MCP mínimo sobre el ejecutor de referencia. Ejecuta (`pubmed_search_exact`) y, si recibe el
 * paquete de filtros (scripts/filter-source.mjs), sirve también la fuente simbólica: el catálogo
 * (`pubmed_filter_catalog`) y la consulta canónica de cada filtro (`pubmed_get_filter`), y comprueba
 * en cada recibo que los filtros declarados van literales en la consulta (`filter_fidelity`).
 *
 * Sin dependencias, a propósito. El protocolo que hace falta aquí son cinco métodos JSON-RPC
 * (initialize, ping, tools/list, tools/call y la notificación de inicializado), y escribirlos a mano
 * cuesta menos que mantener un SDK y su árbol de dependencias en un repositorio que no tenía ninguna.
 * El mismo `createMcpHandler()` lo usan el transporte stdio (`stdio.mjs`, en tu ordenador) y el HTTP
 * (`worker.mjs`, en Cloudflare Workers): dos transportes, un solo comportamiento.
 *
 * Lee también registros por PMID con recibo (`pubmed_fetch_exact`, contrato 1.14.0, especificación 29-):
 * cada PMID pedido sale completo, pendiente o con su error, nunca cortado (scripts/fetch-core.mjs). Y
 * criba por título hasta 50 PMID con recibo (`pubmed_summary_exact`, contrato 1.15.0, diseño 33-), sin
 * abstract: decide qué se lee, nunca qué se destaca (scripts/summary-core.mjs).
 *
 * Lo que este servidor NO hace, y por qué: no reescribe, sanea ni trocea la consulta (por eso existe);
 * no busca en ninguna otra fuente; no acredita que algo se leyera o se entendiera; no guarda nada. Es de
 * solo lectura sobre PubMed.
 */

import { runExact, sha256, ESEARCH_WINDOW, SORT_VALUES } from '../scripts/exact-core.mjs';
import { TransportError } from '../scripts/esearch.mjs';
import { runFetch, fetchFailureReceipt, fetchRequestError, FETCH_RECEIPT_TYPE, FETCH_RECEIPT_VERSION,
  MAX_FETCH_PMIDS, MAX_PLAN_REF, MAX_READ_ID } from '../scripts/fetch-core.mjs';
import { runSummary, summaryFailureReceipt, summaryRequestError, SUMMARY_RECEIPT_TYPE, SUMMARY_RECEIPT_VERSION,
  MAX_SUMMARY_PMIDS, MAX_SCREEN_ID } from '../scripts/summary-core.mjs';
import { dateLimitTags } from '../scripts/parse-filter.mjs';

export const SERVER_NAME = 'pubmed-filters-exact';
export const SERVER_VERSION = '0.2.0';
/**
 * Versiones del protocolo MCP que este servidor cumple. Solo una, y a propósito: la primera versión
 * anunciaba también 2025-03-26 y 2024-11-05 sin cumplirlas (la 2024-11-05 ni siquiera usa este
 * transporte HTTP, y la 2025-03-26 obliga a aceptar lotes). Revisión de Codex, 2026-10-08. Un cliente
 * que pida otra recibe esta y decide; es lo que prevé la negociación del protocolo. La especificación
 * vigente es posterior (2026-07-28); no se anuncia lo que no se ha implementado ni probado.
 */
export const PROTOCOL_VERSIONS = ['2025-06-18'];

/**
 * Tope de PMIDs por llamada en el MCP. ESearch sirve hasta 9.999, pero devolverlos a un chat son
 * decenas de miles de tokens. Para más, el CLI (`scripts/pubmed-exact.mjs`) llega a la ventana entera.
 */
export const MCP_MAX_RETMAX = 1000;
/** Tope de longitud de consulta: generoso (los filtros compuestos rondan 2-7 mil), solo contra abusos. */
export const MCP_MAX_QUERY = 20000;
/** Filtros declarables por consulta: más que los que una búsqueda razonable compone. */
export const MAX_FILTERS_USED = 12;
/** Tope del registro de selección serializado: holgado para un registro real, corto para un abuso. */
export const MAX_SELECTION_RECORD = 16000;

/**
 * Registro de selección por pasada (1.12.0, provenance.selection_record). Medido en la prueba de
 * comportamiento del 2026-10-17/18: ChatGPT reconstruyó el registro DESPUÉS de los resultados en los
 * cinco casos, aunque sus instrucciones pedían hacerlo antes. Pedirlo en las instrucciones no bastó;
 * llevarlo al conector sí deja una prueba: el recibo lo devuelve con la hora del servidor en que llegó,
 * anterior a la consulta a PubMed. Es una DECLARACIÓN del agente: no toca query_integrity ni
 * filter_fidelity, y no certifica que la estrategia sea buena. El servidor no lo guarda.
 */
const FACET_ROLES = ['core', 'concept', 'lane', 'context', 'interpretation'];
/** Recorrido de lectura de la pasada (1.13.0, reading_and_drilldown.reading_path). */
const READING_PATHS = ['complete_retrieval', 'focused_selection', 'exploration_only'];
const DATE_ORIGINS = ['user', 'agent_policy', 'filter', 'none'];
const PMID_ORIGINS = ['search_pass', 'cited_in_document', 'user', 'model_prior_knowledge', 'undetermined'];
const str = (max, extra = {}) => ({ type: 'string', minLength: 1, maxLength: max, ...extra });
const SELECTION_RECORD_SCHEMA = {
  type: 'object',
  description: 'Your selection record for THIS pass, written before you see its results'
    + ' (provenance.selection_record). The receipt echoes it with the server time it arrived, before PubMed'
    + ' is queried, and checks it mechanically against the catalog and filters_used (status.selection_record).'
    + ' It is your declaration: it never changes query_integrity or filter_fidelity and does not certify'
    + ' the strategy. No personal data: it travels back in the receipt.',
  properties: {
    plan_ref: str(80, { description: 'Your id for the plan and its revision, e.g. "plan-1/r2".' }),
    facets: {
      type: 'array', minItems: 1, maxItems: 20,
      items: { type: 'object', properties: { facet: str(200), role_in_question: { type: 'string', enum: FACET_ROLES } },
        required: ['facet', 'role_in_question'], additionalProperties: false },
    },
    filters: {
      type: 'array', maxItems: 60,
      description: 'Every catalog filter whose purpose matches a facet: used or discarded, with the reason.',
      items: { type: 'object', properties: {
        path: str(200), decision: { type: 'string', enum: ['used', 'discarded'] },
        pass_id: str(40, { description: 'Pass where it is used. Omitted on a used filter = this pass.' }),
        role_used: str(40, { description: 'FILTER role from the catalog (concept, question_type, design, harm, outcome,'
          + ' population_setting, editorial, exclusion), not a facet role. Example: facet Spain is core; the'
          + ' Spanish filter role_used is population_setting.' }),
        reason: str(500, { minLength: 3 }),
      }, required: ['path', 'decision', 'reason'], additionalProperties: false },
    },
    pass: {
      type: 'object',
      properties: {
        pass_id: str(40), purpose: str(300), unit_claim: str(300),
        reading_path: { type: 'string', enum: READING_PATHS,
          description: 'How this pass will be read (reading_and_drilldown.reading_path): complete_retrieval (all PMIDs'
            + ' of the set, page by page), focused_selection (which records you will read and why) or exploration_only'
            + ' (size and shape; never counted as read). The first N of a truncated list are not the set, in any order.' },
        selection_reason: str(500, { minLength: 3,
          description: 'Required with focused_selection: what will be read, why it can support the claim, and its limits.' }),
      },
      required: ['pass_id', 'purpose'], additionalProperties: false,
    },
    date_window: {
      type: 'object',
      description: 'Required when the query has a date limit. An agent_policy window needs unrestricted_pass_id:'
        + ' ANOTHER pass with the same core without the window (adaptation.date_window_check). The receipt checks'
        + ' that you declared it, not that it ran: run it and compare. origin filter needs a used filter with an'
        + ' embedded date limit in this query; origin user is your declaration.',
      properties: { limit: str(100), origin: { type: 'string', enum: DATE_ORIGINS },
        unrestricted_pass_id: str(40), reason: str(300) },
      required: ['limit', 'origin'], additionalProperties: false,
    },
    known_pmids: {
      type: 'array', maxItems: 100,
      description: 'PMIDs you will fetch by identifier, with where they came from. "undetermined" is allowed;'
        + ' never invent a source. A PMID fetched by identifier feeds reading, not coverage.',
      items: { type: 'object', properties: { pmid: { type: 'string', pattern: '^[0-9]{1,9}$' },
        origin: { type: 'string', enum: PMID_ORIGINS }, detail: str(200) },
      required: ['pmid', 'origin'], additionalProperties: false },
    },
  },
  required: ['facets', 'filters', 'pass'],
  additionalProperties: false,
};

/**
 * Valida la forma contra el esquema anterior, sin dependencias: tipos, enumerados, longitudes,
 * obligatorios y claves no admitidas. Devuelve el primer error o null. Una forma rota se rechaza antes
 * de llamar a PubMed, como cualquier argumento mal formado.
 */
function shapeError(value, schema, at = 'selection_record') {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${at} debe ser un objeto`;
    const extra = Object.keys(value).filter((k) => !Object.hasOwn(schema.properties, k));
    if (extra.length) return `${at}: claves no admitidas ${extra.join(', ')}`;
    const missing = (schema.required ?? []).filter((k) => !Object.hasOwn(value, k));
    if (missing.length) return `${at}: falta ${missing.join(', ')}`;
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, k)) {
        const e = shapeError(value[k], sub, `${at}.${k}`);
        if (e) return e;
      }
    }
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at} debe ser una lista`;
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) {
      return `${at}: entre ${schema.minItems ?? 0} y ${schema.maxItems} elementos`;
    }
    for (let i = 0; i < value.length; i++) {
      const e = shapeError(value[i], schema.items, `${at}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (typeof value !== 'string') return `${at} debe ser una cadena`;
  if (schema.enum && !schema.enum.includes(value)) return `${at} debe ser uno de: ${schema.enum.join(', ')}`;
  if (value.trim().length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) {
    return `${at}: longitud entre ${schema.minLength ?? 0} y ${schema.maxLength}`;
  }
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${at} no tiene el formato esperado`;
  return null;
}

/**
 * Límite de fecha escrito en la consulta: alguna etiqueta de fecha de PubMed fuera de comillas
 * (scripts/parse-filter.mjs, dateLimitTags). Basta para exigir que el registro diga de dónde sale la
 * ventana; no interpreta su alcance. Este MCP no expone mindate/maxdate, así que no hay otra vía.
 */
export const hasDateLimit = (query) => dateLimitTags(query).length > 0;

/**
 * Comprobación MECÁNICA del registro declarado: que nombre filtros del catálogo, que coincida con
 * filters_used en esta pasada, que los papeles existan y que una ventana de fecha tenga origen y, si es
 * política del agente, su pasada sin ventana. `declared` = no se encontró contradicción;
 * `inconsistent` = la hay, y `problems` dice cuál. Ninguno de los dos juzga si la estrategia es buena.
 */
export function selectionRecordCheck(bundle, record, { query, filtersUsed = [] }) {
  const problems = [];
  const thisPass = record.pass.pass_id;
  const roles = Object.keys(bundle.guidance?.roles ?? {}).filter((k) => typeof bundle.guidance.roles[k] === 'object');
  const resolved = record.filters.map((f) => ({ ...f, resolved: resolvePath(bundle, f.path), passId: f.pass_id ?? thisPass }));
  for (const f of resolved) {
    if (!f.resolved) problems.push(`filters: «${f.path}» no está en el catálogo`);
    if (f.role_used && !roles.includes(f.role_used)) {
      problems.push(`filters: role_used «${f.role_used}» no es un papel de filtro del catálogo (${roles.join(', ')}); el papel de la faceta va en facets`);
    }
  }
  // Una misma ruta en la misma pasada no puede estar usada y descartada a la vez. Pasadas distintas sí.
  const decisions = new Map();
  for (const f of resolved.filter((x) => x.resolved)) {
    const key = `${f.resolved}\u0000${f.passId}`;
    decisions.set(key, new Set([...(decisions.get(key) ?? []), f.decision]));
  }
  for (const [key, set] of decisions) {
    if (set.size > 1) problems.push(`filters: «${key.split('\u0000')[0]}» figura a la vez como usado y descartado en la pasada ${key.split('\u0000')[1]}`);
  }
  const usedHere = new Set(resolved.filter((f) => f.decision === 'used' && f.passId === thisPass && f.resolved).map((f) => f.resolved));
  const sent = new Set();
  for (const p of filtersUsed) {
    const r = resolvePath(bundle, p);
    if (r) sent.add(r);
    else problems.push(`«${p}» va en filters_used y no está en el catálogo`);
  }
  for (const p of sent) if (!usedHere.has(p)) problems.push(`«${p}» va en filters_used pero el registro no lo da por usado en la pasada ${thisPass}`);
  for (const p of usedHere) if (!sent.has(p)) problems.push(`el registro da «${p}» por usado en la pasada ${thisPass}, pero no va en filters_used`);

  // Ventana de fecha. Una ventana «de filtro» tiene que salir de un filtro con fecha embebida que vaya
  // usado y literal en esta pasada; lo que quede fuera de su texto es otra ventana, con su propio origen.
  const flatQuery = flat(query);
  const dateFilters = [...usedHere].filter((p) => bundle.catalog.filters.find((e) => e.path === p)?.embedded_date_limit
    && flatQuery.includes(flat(bundle.filters[p].query)));
  const outside = dateFilters.reduce((q, p) => q.split(flat(bundle.filters[p].query)).join(' '), flatQuery);
  const dw = record.date_window;
  if (hasDateLimit(query)) {
    if (!dw) problems.push('la consulta lleva límite de fecha y el registro no declara date_window (origen de la ventana)');
    else if (dw.origin === 'none') problems.push('date_window dice «none», pero la consulta lleva límite de fecha');
    else if (dw.origin === 'filter') {
      // Sin filtro con fecha usado y literal, `outside` es la consulta entera: un solo control cubre los dos casos.
      if (hasDateLimit(outside)) {
        problems.push('date_window dice «filter», pero la ventana no sale (o no sale toda) de un filtro con fecha embebida usado y literal en esta pasada: declara su propio origen');
      }
    } else if (dw.origin === 'agent_policy') {
      if (!dw.unrestricted_pass_id) {
        problems.push('ventana de fecha por política del agente sin declarar la pasada del mismo núcleo sin ella (adaptation.date_window_check)');
      } else if (dw.unrestricted_pass_id === thisPass) {
        problems.push('unrestricted_pass_id es esta misma pasada: la pasada sin ventana tiene que ser otra');
      }
    }
  } else if (dw && dw.origin !== 'none') {
    problems.push(`date_window declara una ventana (${dw.origin}) que la consulta no lleva`);
  }

  // Recorrido de lectura (1.13.0). Se contrasta el registro consigo mismo, nunca con la página: una
  // primera página parcial no contradice un complete_retrieval, porque el servidor no sabe si vendrán más.
  // Que falte el recorrido no es una contradicción: va a `notes`, aparte de `problems`, porque cualquier
  // problema convierte el registro en inconsistent y un registro de la 1.12 debe seguir siendo válido.
  const notes = [];
  const readingPath = record.pass.reading_path;
  if (readingPath === undefined) notes.push('reading_path no declarado');
  else if (readingPath === 'focused_selection' && record.pass.selection_reason === undefined) {
    problems.push('focused_selection sin selection_reason: di qué se leerá, por qué puede sostener la afirmación y sus límites');
  }
  return { status: problems.length ? 'inconsistent' : 'declared', problems, notes };
}

/**
 * Qué esconde cada orden (1.14.1, auditoría de lumbalgia del 26/10). El aviso iba en un solo sentido, y
 * una revisión de 2026 quedó 17.ª por relevancia con 15 leídos. La misma frase en la herramienta y en
 * `sort`, que es donde se decide el orden; la regla entera va en `guidance` del catálogo.
 */
const ORDER_HIDES_BY_AGE = 'Each order hides something by age: the default order pushes older pivotal records'
  + ' down, relevance pushes records indexed in recent months down (guidance.order_hides_by_age in'
  + ' pubmed_filter_catalog).';

/**
 * Cribado por título (1.15.0, diseño 33-). La frase va en la búsqueda, que es donde se decide cuánto de
 * la lista se mira; la regla entera, en `guidance.title_screen`.
 */
const TITLE_SCREEN = 'To screen a whole list by title, send its PMIDs to pubmed_summary_exact (up to'
  + ` ${MAX_SUMMARY_PMIDS} per call): a title screen decides what to read, never what to report`
  + ' (guidance.title_screen in pubmed_filter_catalog).';

export const TOOL = {
  name: 'pubmed_search_exact',
  title: 'PubMed literal search with integrity receipt',
  description: [
    'Execute ONE literal PubMed query through NCBI E-utilities ESearch (HTTP POST; the query is never',
    'rewritten, sanitized or split) and return an auditable search receipt.',
    'Send the complete query with any curated filter expanded inline, exactly as it must run.',
    'Read status.query_integrity BEFORE using result_count:',
    '"verified" = PubMed returned its full diagnostics, nothing was dropped, and the sent query has no',
    'field tag, group tag, modifier or look-alike asterisk that PubMed ignores silently. It is a',
    'mechanical check only: it does not mean the query fits the question (automatic term mapping,',
    'MeSH choice and boolean logic still need review), nor anything about coverage;',
    '"failed" = the query did NOT run as written: see problems, fix the query, and do not report the',
    'count as a search result;',
    '"unsupported" = cannot be verified.',
    'result_count is what PubMed counts; records_retrieved is how many PMIDs came back',
    `(retmax, default 0, max ${MCP_MAX_RETMAX}); neither means anything was read.`,
    'PMIDs come in PubMed\'s default order (most recent entry first) unless you send sort "relevance";',
    'the first N of a truncated list are not the set, in any order.',
    ORDER_HIDES_BY_AGE,
    TITLE_SCREEN,
    'For the next page send retstart =',
    'next_retstart from the receipt; when it is null, next_retstart_reason says why (end_of_set,',
    'window_limit, count_only, empty_page, not_verified, page_adjusted), and null never means everything',
    'was retrieved. Pages are independent calls: joining them is an operational retrieval without a fixed',
    'snapshot, never a certified complete set.',
    'Never shorten, split or "fix" a curated filter to make it fit: report the failure instead.',
    'Send selection_record with every pass: it is the only way to show that your selection record was',
    'supplied before this pass was executed; status.selection_record is "not_declared" without it.',
    'Read-only; queries PubMed only.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: MCP_MAX_QUERY,
        description: 'The literal PubMed query, with field tags and any filter expanded inline.',
      },
      retmax: {
        type: 'integer',
        minimum: 0,
        maximum: MCP_MAX_RETMAX,
        default: 0,
        description: 'How many PMIDs to return (0 = count and diagnostics only).',
      },
      retstart: {
        type: 'integer',
        minimum: 0,
        maximum: ESEARCH_WINDOW - 1,
        default: 0,
        description: 'Offset of the first PMID returned (0 = first page). Use next_retstart from the previous'
          + ` receipt. PubMed serves only the first ${ESEARCH_WINDOW} records; a page crossing that edge is trimmed`
          + ' before sending (request.retmax_sent).',
      },
      sort: {
        type: 'string',
        enum: ['relevance'],
        description: 'Omit for PubMed\'s default order (most recent entry first). "relevance" is Best Match. Neither'
          + ' order makes a truncated list representative of the set. ' + ORDER_HIDES_BY_AGE,
      },
      filters_used: {
        type: 'array',
        maxItems: MAX_FILTERS_USED,
        items: { type: 'string', minLength: 1, maxLength: 200 },
        description: 'Paths or jnl_ ids of the catalog filters this query contains, as returned by'
          + ' pubmed_get_filter. The receipt then checks that each one is present literally'
          + ' (status.filter_fidelity). Leave out a filter you modified on purpose and declare the'
          + ' modification in your provenance instead.',
      },
      selection_record: SELECTION_RECORD_SCHEMA,
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

/**
 * Lectura por PMID con recibo (1.14.0, especificación 29- y adenda de Codex del 24/10). Medido en las
 * pruebas de superficie del 21-23/10: se confundían PMID pedidos con abstracts conservados, y un tramo
 * final de un texto llegaba marcado «no truncado». Aquí cada registro va entero o no va, y lo dice.
 */
export const FETCH_TOOL = {
  name: 'pubmed_fetch_exact',
  title: 'Read PubMed records by PMID, with a delivery receipt',
  description: [
    `Fetch 1 to ${MAX_FETCH_PMIDS} PubMed records by PMID through NCBI EFetch (XML, HTTP POST) and return each one`,
    'whole, or say why not. It never searches, widens the list, follows references or swaps a PMID for a DOI,',
    'a title or a neighbouring PMID. Per PMID, record_status is: with_abstract (abstract_canonical holds the',
    'complete abstract as JSON: every block and section in order, OtherAbstract kept apart, superscripts as',
    '^(...) and subscripts as _(...), with abstract_sha256 over it); without_abstract (record found, no',
    'abstract text); not_found (absent from THIS EFetch response, not proof that the article does not exist:',
    'request it alone); error (reason says why; never an absent abstract). Records are never cut: one that',
    'does not fit in what is left of the response goes to pending_pmids (request it again); one that does not',
    'fit even alone is error record_too_large. status.delivery is complete, partial or failed;',
    'status.record_identity is verified, failed or unsupported. Search and reading share the same rate limit.',
    'This receipt says what PubMed returned and what was delivered, never that it was read or understood.',
    'Read-only; queries PubMed only.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      pmids: {
        type: 'array', minItems: 1, maxItems: MAX_FETCH_PMIDS, uniqueItems: true,
        items: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' },
        description: 'PMIDs as strings, in the order you want them back. Never converted or corrected.',
      },
      context: {
        type: 'object',
        properties: {
          plan_ref: str(MAX_PLAN_REF, { description: 'The plan_ref of your search plan, as in selection_record.' }),
          read_id: str(MAX_READ_ID, { description: 'Your id for this reading operation: a retry keeps it, another reading uses another.' }),
        },
        required: ['plan_ref', 'read_id'],
        additionalProperties: false,
      },
    },
    required: ['pmids', 'context'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

/**
 * Cribado por PMID con recibo (1.15.0, diseño 33-, alternativa b). Calcado de la lectura: misma cola,
 * mismo `run`, mismo presupuesto y la misma regla de no cortar. Medido en la lumbalgia del 26/10: cribar
 * por abstracts una pasada de 59 eran unas 12 lecturas, y se leyeron 15; por título es una llamada.
 */
export const SUMMARY_TOOL = {
  name: 'pubmed_summary_exact',
  title: 'Screen PubMed records by PMID (title, year, type), with a delivery receipt',
  description: [
    `Fetch the NCBI summary of 1 to ${MAX_SUMMARY_PMIDS} PubMed records by PMID through ESummary (JSON, HTTP POST):`,
    'title, year, publication types, journal, DOIs and has_abstract (NCBI\'s flag), never the abstract. It is',
    'for screening a whole list by title to decide what to read: a title screen never turns a record into a',
    'finding or a highlight; read it first with pubmed_fetch_exact. Records set aside on title are counted',
    'apart (counts_as: titles_screened), never as read and discarded. It never searches, widens the list or',
    'swaps a PMID. Per PMID, record_status is: found; not_found (NCBI said it has no summary in THIS response,',
    'not proof that the article does not exist: request it alone); error (reason says why). Titles are never',
    'cut: a record that does not fit in what is left goes to pending_pmids (request it again).',
    'status.delivery is complete, partial or failed; status.record_identity is verified or failed.',
    'Search, reading and screening share the same rate limit. Read-only; queries PubMed only.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      pmids: {
        type: 'array', minItems: 1, maxItems: MAX_SUMMARY_PMIDS, uniqueItems: true,
        items: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' },
        description: 'PMIDs as strings, in the order you want them back. Never converted or corrected.',
      },
      context: {
        type: 'object',
        properties: {
          plan_ref: str(MAX_PLAN_REF, { description: 'The plan_ref of your search plan, as in selection_record.' }),
          screen_id: str(MAX_SCREEN_ID, { description: 'Your id for this screening operation: a retry keeps it, another screening uses another.' }),
        },
        required: ['plan_ref', 'screen_id'],
        additionalProperties: false,
      },
    },
    required: ['pmids', 'context'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const CATALOG_TOOL = {
  name: 'pubmed_filter_catalog',
  title: 'Catalog of curated PubMed filters, with the role of each one',
  description: [
    'List every curated filter in pubmed-filters (48 retrieval filters; journal lists on request) with',
    'what it is for, its validation status as stated in its header, and its default ROLE, plus the',
    'guidance on how each role is composed. Use it BEFORE composing a search: split the question into',
    'facets, check every facet against this catalog, and record why a matching filter is not used.',
    'The role is a default: concept filters are ORed inside their concept; population, setting and',
    'geography filters are parallel lanes unless they define the population; journal lists never',
    'restrict the core; exclusion filters are appended with NOT. Then fetch each chosen filter with',
    'pubmed_get_filter. Read-only; no PubMed call.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      role: { type: 'string', maxLength: 40, description: 'Only filters with this role.' },
      include_journals: { type: 'boolean', default: false, description: 'Also list the journal lists (editorial role).' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export const GET_FILTER_TOOL = {
  name: 'pubmed_get_filter',
  title: 'Canonical query of one curated filter',
  description: [
    'Return the exact query of one catalog filter, extracted by the reference parser (all lines joined,',
    'metadata block removed), with its SHA-256, role, how to compose it, and its flags: an exclusion',
    'filter starts with NOT and must be appended as (topic) NOT (filter), never with AND; a filter with an',
    'embedded date limit overrides your date policy. Paste the query unchanged into pubmed_search_exact',
    'and list its path in filters_used. Never rebuild a filter from memory. Read-only; no PubMed call.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 200, description: 'Catalog path (filters/...txt) or journal list id (jnl_...).' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Solo claves PROPIAS que el catálogo lista, con una consulta canónica no vacía. Revisión de Codex del
 * 2026-10-16: `bundle.filters['__proto__']` (o `constructor`, `toString`…) es un valor heredado; su
 * `.query` era undefined, `flat()` lo convertía en la cadena "undefined", y una consulta que la
 * contuviera daba filter_fidelity verified para un filtro que no existe.
 */
const catalogPaths = new WeakMap();
function resolvePath(bundle, p) {
  if (!catalogPaths.has(bundle)) {
    catalogPaths.set(bundle, new Set([...bundle.catalog.filters, ...bundle.catalog.journal_lists].map((e) => e.path)));
  }
  const known = catalogPaths.get(bundle);
  const candidate = known.has(p) ? p : /^jnl_[a-z0-9_]+$/.test(p) ? `filters/journals/${p}.txt` : null;
  if (!candidate || !known.has(candidate) || !Object.hasOwn(bundle.filters, candidate)) return null;
  const query = bundle.filters[candidate]?.query;
  return typeof query === 'string' && query.trim() !== '' ? candidate : null;
}

/**
 * ¿Qué precede a una aparición, saltando espacios y CUALQUIER número de paréntesis de apertura? Una
 * exclusión (empieza por NOT) solo está bien compuesta si la precede un operando —un término o un
 * paréntesis de cierre—: `(tema) NOT (...)`. Precedida por AND, OR o NOT, o al principio de la consulta,
 * PubMed no la lee como exclusión (`AND (NOT X)` = `AND X`). Revisión de Codex del 2026-10-16: mirar solo
 * ocho caracteres y un paréntesis dejaba pasar `AND ((NOT X))`.
 */
function precedingToken(sent, at) {
  let i = at - 1;
  while (i >= 0 && (sent[i] === ' ' || sent[i] === '(')) i--;
  if (i < 0) return '';
  const word = sent.slice(0, i + 1).match(/([A-Za-z]+)$/);
  return word ? word[1] : sent[i];
}

/**
 * ¿Lleva la consulta enviada cada filtro declarado, literal? Se compara con los espacios colapsados:
 * un salto de línea de más no cambia lo que PubMed ejecuta, una palabra cambiada sí. En una exclusión se
 * inspeccionan TODAS sus apariciones: una bien compuesta no tapa otra mal compuesta más adelante.
 * Qué certifica `verified`: que cada filtro declarado está literal y que ninguna aparición de una
 * exclusión sigue a un operador. No certifica que el filtro sea el adecuado para la pregunta.
 */
export function filterFidelity(bundle, query, declared) {
  const sent = flat(query);
  const filters = declared.map((p) => {
    const path = resolvePath(bundle, p);
    if (!path) return { declared: p, found_literal: false, problem: 'no está en el catálogo' };
    const canonical = flat(bundle.filters[path].query);
    const positions = [];
    for (let at = sent.indexOf(canonical); at !== -1; at = sent.indexOf(canonical, at + 1)) positions.push(at);
    if (positions.length === 0) {
      return { declared: p, path, found_literal: false, problem: 'la consulta no contiene el filtro literal: modificado o reconstruido' };
    }
    if (/^NOT\b/i.test(canonical)) {
      const bad = positions.map((at) => precedingToken(sent, at)).filter((t) => t === '' || /^(AND|OR|NOT)$/i.test(t));
      if (bad.length) {
        return { declared: p, path, found_literal: true,
          problem: `filtro de exclusión precedido de ${bad[0] === '' ? 'nada (inicio de la consulta)' : bad[0].toUpperCase()}: PubMed no lo lee como exclusión (AND (NOT X) = AND X)` };
      }
    }
    return { declared: p, path, found_literal: true, problem: null };
  });
  return { status: filters.every((f) => f.problem === null) ? 'verified' : 'failed', filters };
}

function catalogView(bundle, args) {
  const role = args.role;
  const pick = (f) => ({ path: f.path, title: f.title, description: f.description, role: f.role,
    registry_key: f.registry_key, pair: f.pair, exclusion: f.exclusion, embedded_date_limit: f.embedded_date_limit,
    validation: f.validation });
  const filters = bundle.catalog.filters.filter((f) => !role || f.role === role).map(pick);
  const journals = args.include_journals && (!role || role === 'editorial')
    ? bundle.catalog.journal_lists.map((j) => ({ id: j.id, name: j.name, description: j.description, role: j.role }))
    : undefined;
  return {
    contract_version: bundle.contract_version,
    catalog_sha256: bundle.catalog_sha256,
    validation_values: bundle.catalog.validation_values,
    guidance: bundle.guidance,
    counts: { ...bundle.catalog.counts, returned_filters: filters.length },
    filters,
    ...(journals ? { journal_lists: journals } : {}),
  };
}

function filterView(bundle, p) {
  const path = resolvePath(bundle, p);
  if (!path) return null;
  const entry = bundle.catalog.filters.find((f) => f.path === path)
    ?? bundle.catalog.journal_lists.find((j) => j.path === path);
  const role = entry.role;
  const how = bundle.guidance.roles?.[role]?.how ?? null;
  const exclusion = Boolean(entry.exclusion);
  return {
    path,
    title: entry.title ?? entry.name,
    description: entry.description,
    role,
    how_to_compose: exclusion
      ? `Append it after the topic exactly as returned, which already starts with NOT: (topic) NOT (...). Never with AND: PubMed reads AND (NOT X) as AND X. ${how ?? ''}`.trim()
      : how,
    exclusion,
    embedded_date_limit: Boolean(entry.embedded_date_limit),
    validation: entry.validation ?? 'journal_list_not_validated',
    reference: entry.reference ?? null,
    query: bundle.filters[path].query,
    query_sha256: bundle.filters[path].query_sha256,
    source: bundle.filters[path].source,
    catalog_sha256: bundle.catalog_sha256,
  };
}

const INSTRUCTIONS = 'Literal PubMed execution for the pubmed-filters neurosymbolic router '
  + '(github.com/ernestobarrera/pubmed-filters). Every call returns a receipt; '
  + 'status.query_integrity decides whether the count may be used. To read records by PMID use '
  + 'pubmed_fetch_exact: each one comes back whole, pending or as an error with its reason, never cut. '
  + 'To screen a list by title use pubmed_summary_exact: it decides what to read, never what to report.';
const SOURCE_INSTRUCTIONS = 'Before composing, call pubmed_filter_catalog and check every facet of the '
  + 'question against it; fetch each chosen filter with pubmed_get_filter, paste it unchanged, and '
  + 'declare it in filters_used so the receipt can check status.filter_fidelity. Send your selection_record '
  + 'with each pass, before its results: the receipt timestamps it on arrival.';

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * Espaciado entre llamadas a NCBI dentro de un mismo proceso: 3/s sin clave, 10/s con clave (límites
 * de NCBI). En Workers cada instancia lleva su propio reloj, así que es una cortesía, no una garantía.
 * Y la cola tiene fondo: si una llamada tuviera que esperar más de `MAX_QUEUE_MS`, se rechaza en vez de
 * acumular promesas en memoria (Codex, 2026-10-08). Devuelve false si no hay sitio.
 */
export const MAX_QUEUE_MS = 15000;
function makeThrottle(minMs, maxQueueMs = MAX_QUEUE_MS) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    if (wait > maxQueueMs) return false;
    next = Math.max(now, next) + minMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return true;
  };
}

/**
 * Devuelve `handle(message) => response | null`. `null` para notificaciones, que no se contestan.
 * `run` se adjunta a cada recibo (versión de contrato, commit, hash del router) y lo pone quien
 * conoce el despliegue: stdio lo calcula con git, el Worker lo trae sellado del despliegue.
 * `filters` es el paquete de scripts/filter-source.mjs. Sin él, el servidor solo ejecuta: no anuncia
 * herramientas de catálogo ni acepta filters_used, en vez de fingir que comprueba lo que no conoce.
 */
export function createMcpHandler({
  apiKey = '', email = '', run = null, engine = 'mcp', fetcher, now, timeoutMs, maxQueueMs, filters = null,
} = {}) {
  // Un solo limitador para búsqueda, lectura y cribado: cuotas independientes multiplicarían el ritmo real a NCBI.
  const throttle = makeThrottle(apiKey ? 110 : 350, maxQueueMs);
  const tools = filters ? [TOOL, CATALOG_TOOL, GET_FILTER_TOOL, FETCH_TOOL, SUMMARY_TOOL] : [TOOL, FETCH_TOOL, SUMMARY_TOOL];
  const textResult = (structured) => ({ content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured, isError: false });
  // El recibo de lectura va como JSON compacto también en el texto: es el que mide el presupuesto (29-, §3.6).
  const compactResult = (structured, isError) => ({ content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError });

  /**
   * Lectura por PMID. La hora y el `attempt_id` se toman al recibir, antes de validar: un rechazo de
   * esquema también queda identificado. Lo inválido se rechaza antes de la cola y de NCBI.
   */
  async function callFetch(args) {
    const receivedAt = (now ? now() : new Date()).toISOString();
    const attemptId = globalThis.crypto.randomUUID();
    const extra = args === null || typeof args !== 'object' || Array.isArray(args) ? ['(los argumentos no son un objeto)']
      : Object.keys(args).filter((k) => !Object.hasOwn(FETCH_TOOL.inputSchema.properties, k));
    const invalid = extra.length ? `argumentos no admitidos: ${extra.join(', ')}` : fetchRequestError(args.pmids, args.context);
    if (invalid) {
      return compactResult({ run, receipt_type: FETCH_RECEIPT_TYPE, receipt_version: FETCH_RECEIPT_VERSION, attempt_id: attemptId,
        received_at: receivedAt, rejected_before_ncbi: true, error: invalid }, true);
    }
    const opts = { run, apiKey, email, tool: 'pubmed-filters-mcp', engine, fetcher, now, timeoutMs, attemptId, receivedAt };
    if (!(await throttle())) {
      const busy = await fetchFailureReceipt(args.pmids, args.context, opts, { code: 'service_busy',
        message: 'SERVICIO_OCUPADO: demasiadas llamadas en cola; vuelve a intentarlo en unos segundos' });
      return compactResult(busy, true);
    }
    const receipt = await runFetch(args.pmids, args.context, opts);
    return compactResult(receipt, receipt.status.delivery === 'failed');
  }

  /** Cribado por PMID: la misma forma que la lectura, con su núcleo y su contexto (`screen_id`). */
  async function callSummary(args) {
    const receivedAt = (now ? now() : new Date()).toISOString();
    const attemptId = globalThis.crypto.randomUUID();
    const extra = args === null || typeof args !== 'object' || Array.isArray(args) ? ['(los argumentos no son un objeto)']
      : Object.keys(args).filter((k) => !Object.hasOwn(SUMMARY_TOOL.inputSchema.properties, k));
    const invalid = extra.length ? `argumentos no admitidos: ${extra.join(', ')}` : summaryRequestError(args.pmids, args.context);
    if (invalid) {
      return compactResult({ run, receipt_type: SUMMARY_RECEIPT_TYPE, receipt_version: SUMMARY_RECEIPT_VERSION, attempt_id: attemptId,
        received_at: receivedAt, rejected_before_ncbi: true, error: invalid }, true);
    }
    const opts = { run, apiKey, email, tool: 'pubmed-filters-mcp', engine, fetcher, now, timeoutMs, attemptId, receivedAt };
    if (!(await throttle())) {
      const busy = await summaryFailureReceipt(args.pmids, args.context, opts, { code: 'service_busy',
        message: 'SERVICIO_OCUPADO: demasiadas llamadas en cola; vuelve a intentarlo en unos segundos' });
      return compactResult(busy, true);
    }
    const receipt = await runSummary(args.pmids, args.context, opts);
    return compactResult(receipt, receipt.status.delivery === 'failed');
  }

  function callSourceTool(name, args) {
    const extra = Object.keys(args).filter((k) => !(k in (name === CATALOG_TOOL.name ? CATALOG_TOOL : GET_FILTER_TOOL).inputSchema.properties));
    if (extra.length) return toolError({ error: `argumentos no admitidos: ${extra.join(', ')}` });
    if (name === CATALOG_TOOL.name) {
      if (args.role !== undefined && typeof args.role !== 'string') return toolError({ error: 'role debe ser una cadena' });
      if (args.include_journals !== undefined && typeof args.include_journals !== 'boolean') return toolError({ error: 'include_journals debe ser booleano' });
      return textResult(catalogView(filters, args));
    }
    if (typeof args.path !== 'string' || args.path.trim() === '') return toolError({ error: 'path debe ser una cadena no vacía' });
    const view = filterView(filters, args.path.trim());
    return view ? textResult(view)
      : toolError({ error: `No hay ningún filtro «${args.path}» en el catálogo. Consulta pubmed_filter_catalog; no lo reconstruyas de memoria.` });
  }

  async function callTool(params) {
    if (filters && (params?.name === CATALOG_TOOL.name || params?.name === GET_FILTER_TOOL.name)) {
      return { result: callSourceTool(params.name, params.arguments ?? {}) };
    }
    if (params?.name === FETCH_TOOL.name) return { result: await callFetch(params.arguments ?? {}) };
    if (params?.name === SUMMARY_TOOL.name) return { result: await callSummary(params.arguments ?? {}) };
    if (params?.name !== TOOL.name) return { error: [-32602, `Herramienta desconocida: ${params?.name}`] };
    const args = params.arguments ?? {};
    const extra = Object.keys(args).filter((k) => !(k in TOOL.inputSchema.properties));
    const query = args.query;
    const retmax = args.retmax ?? 0;
    // El valor por defecto solo cuando falta: `retstart: null` no es un entero y se rechaza (Codex, P3).
    const retstart = Object.hasOwn(args, 'retstart') ? args.retstart : 0;
    const sort = args.sort;
    const used = args.filters_used;
    const record = args.selection_record;
    // La hora del servidor se toma al recibir, antes de la cola y de PubMed: es lo que permite distinguir
    // un registro declarado antes de la ejecución de una explicación escrita después.
    const receivedAt = (now ? now() : new Date()).toISOString();
    const recordText = record === undefined ? null : JSON.stringify(record);
    // Página y orden (1.13.0): se validan aquí, en la interfaz del MCP, y otra vez en el ejecutor.
    const pageInvalid = !Number.isSafeInteger(retstart) || retstart < 0 || retstart > ESEARCH_WINDOW - 1
      ? `retstart debe ser un entero entre 0 y ${ESEARCH_WINDOW - 1}`
      : sort !== undefined && !SORT_VALUES.includes(sort)
        ? `sort solo admite ${SORT_VALUES.join(', ')}; omítelo para el orden de PubMed` : null;
    const invalid = extra.length > 0 ? `argumentos no admitidos: ${extra.join(', ')}`
      : typeof query !== 'string' || query.trim() === '' ? 'query debe ser una cadena no vacía'
        : query.length > MCP_MAX_QUERY ? `query supera ${MCP_MAX_QUERY} caracteres`
          : !Number.isSafeInteger(retmax) || retmax < 0 || retmax > MCP_MAX_RETMAX
            ? `retmax debe ser un entero entre 0 y ${MCP_MAX_RETMAX}`
            : pageInvalid ? pageInvalid
            : used !== undefined && !filters ? 'filters_used no se puede comprobar: este servidor no tiene el catálogo de filtros'
              : used !== undefined && (!Array.isArray(used) || used.length > MAX_FILTERS_USED
                || !used.every((u) => typeof u === 'string' && u.trim() !== '' && u.length <= 200))
                ? `filters_used debe ser una lista de hasta ${MAX_FILTERS_USED} rutas o ids`
                : record !== undefined && !filters ? 'selection_record no se puede comprobar: este servidor no tiene el catálogo de filtros'
                  : record !== undefined && recordText.length > MAX_SELECTION_RECORD
                    ? `selection_record supera ${MAX_SELECTION_RECORD} caracteres`
                    : record !== undefined ? shapeError(record, SELECTION_RECORD_SCHEMA) : null;
    if (invalid) return { result: toolError({ error: invalid, result_count: null }) };

    if (!(await throttle())) {
      return { result: toolError({ error: 'SERVICIO_OCUPADO: demasiadas búsquedas en cola; vuelve a intentarlo en unos segundos.', result_count: null }) };
    }
    try {
      const receipt = await runExact(query, {
        retmax, retstart, ...(sort !== undefined ? { sort } : {}), apiKey, email, tool: 'pubmed-filters-mcp', engine,
        ...(fetcher ? { fetcher } : {}), ...(now ? { now } : {}), ...(timeoutMs ? { timeoutMs } : {}),
      });
      const structured = { run, ...receipt };
      if (used !== undefined) {
        const fidelity = filterFidelity(filters, query, used);
        structured.status = { ...structured.status, filter_fidelity: fidelity.status };
        structured.filter_fidelity = fidelity.filters;
        structured.catalog_sha256 = filters.catalog_sha256;
      }
      if (record === undefined) {
        structured.status = { ...structured.status, selection_record: 'not_declared' };
      } else {
        const check = selectionRecordCheck(filters, record, { query, filtersUsed: used ?? [] });
        structured.status = { ...structured.status, selection_record: check.status };
        structured.selection_record = {
          declared_by: 'agent',
          received_at: receivedAt,
          sha256: await sha256(recordText),
          record,
          problems: check.problems,
          notes: check.notes,
          catalog_sha256: filters.catalog_sha256,
        };
      }
      return { result: textResult(structured) };
    } catch (e) {
      return {
        result: toolError({
          sent_query: query,
          transport_failure: e instanceof TransportError,
          error: String(e?.message ?? e),
          result_count: null,
          note: 'No es un recuento de cero ni un resultado vacío: la consulta no produjo un resultado utilizable.',
        }),
      };
    }
  }

  return async function handle(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return fail(message?.id ?? null, -32600, 'Petición JSON-RPC inválida');
    }
    const { id, method, params } = message;
    // Una respuesta del cliente (trae id y result/error, sin method) no se contesta: este servidor
    // nunca le hace peticiones, así que no espera ninguna.
    if (!('method' in message) && ('result' in message || 'error' in message)) return null;
    const isNotification = id === undefined;
    if (typeof method !== 'string') return isNotification ? null : fail(id ?? null, -32600, 'Falta method');
    if (isNotification) return null; // notifications/initialized, cancelled… no se contestan

    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return ok(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: 'PubMed literal (pubmed-filters)', version: SERVER_VERSION },
          instructions: filters ? `${INSTRUCTIONS} ${SOURCE_INSTRUCTIONS}` : INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools });
      case 'tools/call': {
        const { result, error } = await callTool(params);
        return error ? fail(id, error[0], error[1]) : ok(id, result);
      }
      default:
        return fail(id, -32601, `Método no soportado: ${method}`);
    }
  };
}

function toolError(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
}

export { ESEARCH_WINDOW };
