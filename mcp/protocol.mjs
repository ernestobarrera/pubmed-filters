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
 * Lo que este servidor NO hace, y por qué: no reescribe, sanea ni trocea la consulta (por eso existe);
 * no busca en ninguna otra fuente; no lee abstracts; no guarda nada. Es de solo lectura sobre PubMed.
 */

import { runExact, ESEARCH_WINDOW } from '../scripts/exact-core.mjs';
import { TransportError } from '../scripts/esearch.mjs';

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
    'Never shorten, split or "fix" a curated filter to make it fit: report the failure instead.',
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
      filters_used: {
        type: 'array',
        maxItems: MAX_FILTERS_USED,
        items: { type: 'string', minLength: 1, maxLength: 200 },
        description: 'Paths or jnl_ ids of the catalog filters this query contains, as returned by'
          + ' pubmed_get_filter. The receipt then checks that each one is present literally'
          + ' (status.filter_fidelity). Leave out a filter you modified on purpose and declare the'
          + ' modification in your provenance instead.',
      },
    },
    required: ['query'],
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
  + 'status.query_integrity decides whether the count may be used.';
const SOURCE_INSTRUCTIONS = 'Before composing, call pubmed_filter_catalog and check every facet of the '
  + 'question against it; fetch each chosen filter with pubmed_get_filter, paste it unchanged, and '
  + 'declare it in filters_used so the receipt can check status.filter_fidelity.';

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
  const throttle = makeThrottle(apiKey ? 110 : 350, maxQueueMs);
  const tools = filters ? [TOOL, CATALOG_TOOL, GET_FILTER_TOOL] : [TOOL];
  const textResult = (structured) => ({ content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured, isError: false });

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
    if (params?.name !== TOOL.name) return { error: [-32602, `Herramienta desconocida: ${params?.name}`] };
    const args = params.arguments ?? {};
    const extra = Object.keys(args).filter((k) => !(k in TOOL.inputSchema.properties));
    const query = args.query;
    const retmax = args.retmax ?? 0;
    const used = args.filters_used;
    const invalid = extra.length > 0 ? `argumentos no admitidos: ${extra.join(', ')}`
      : typeof query !== 'string' || query.trim() === '' ? 'query debe ser una cadena no vacía'
        : query.length > MCP_MAX_QUERY ? `query supera ${MCP_MAX_QUERY} caracteres`
          : !Number.isSafeInteger(retmax) || retmax < 0 || retmax > MCP_MAX_RETMAX
            ? `retmax debe ser un entero entre 0 y ${MCP_MAX_RETMAX}`
            : used !== undefined && !filters ? 'filters_used no se puede comprobar: este servidor no tiene el catálogo de filtros'
              : used !== undefined && (!Array.isArray(used) || used.length > MAX_FILTERS_USED
                || !used.every((u) => typeof u === 'string' && u.trim() !== '' && u.length <= 200))
                ? `filters_used debe ser una lista de hasta ${MAX_FILTERS_USED} rutas o ids` : null;
    if (invalid) return { result: toolError({ error: invalid, result_count: null }) };

    if (!(await throttle())) {
      return { result: toolError({ error: 'SERVICIO_OCUPADO: demasiadas búsquedas en cola; vuelve a intentarlo en unos segundos.', result_count: null }) };
    }
    try {
      const receipt = await runExact(query, {
        retmax, apiKey, email, tool: 'pubmed-filters-mcp', engine,
        ...(fetcher ? { fetcher } : {}), ...(now ? { now } : {}), ...(timeoutMs ? { timeoutMs } : {}),
      });
      const structured = { run, ...receipt };
      if (used !== undefined) {
        const fidelity = filterFidelity(filters, query, used);
        structured.status = { ...structured.status, filter_fidelity: fidelity.status };
        structured.filter_fidelity = fidelity.filters;
        structured.catalog_sha256 = filters.catalog_sha256;
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
