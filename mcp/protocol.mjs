/**
 * Servidor MCP mínimo sobre el ejecutor de referencia. Una sola herramienta: `pubmed_search_exact`.
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
export const SERVER_VERSION = '0.1.0';
/** Versiones del protocolo MCP que este servidor sabe hablar, de la más nueva a la más vieja. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * Tope de PMIDs por llamada en el MCP. ESearch sirve hasta 9.999, pero devolverlos a un chat son
 * decenas de miles de tokens. Para más, el CLI (`scripts/pubmed-exact.mjs`) llega a la ventana entera.
 */
export const MCP_MAX_RETMAX = 1000;
/** Tope de longitud de consulta: generoso (los filtros compuestos rondan 2-7 mil), solo contra abusos. */
export const MCP_MAX_QUERY = 20000;

export const TOOL = {
  name: 'pubmed_search_exact',
  title: 'PubMed literal search with integrity receipt',
  description: [
    'Execute ONE literal PubMed query through NCBI E-utilities ESearch (HTTP POST; the query is never',
    'rewritten, sanitized or split) and return an auditable search receipt.',
    'Send the complete query with any curated filter expanded inline, exactly as it must run.',
    'Read status.query_integrity BEFORE using result_count:',
    '"verified" = PubMed returned its full diagnostics and nothing was dropped;',
    '"failed" = the diagnostics, or a field tag PubMed does not know (PubMed never reports those),',
    'show the query did NOT run as written: see problems, fix the query, and do not report the count',
    'as a search result;',
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
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

const INSTRUCTIONS = 'Literal PubMed execution for the pubmed-filters neurosymbolic router '
  + '(github.com/ernestobarrera/pubmed-filters). Every call returns a receipt; '
  + 'status.query_integrity decides whether the count may be used.';

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * Espaciado entre llamadas a NCBI dentro de un mismo proceso: 3/s sin clave, 10/s con clave (límites
 * de NCBI). En Workers cada instancia lleva su propio reloj, así que es una cortesía, no una garantía.
 */
function makeThrottle(minMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

/**
 * Devuelve `handle(message) => response | null`. `null` para notificaciones, que no se contestan.
 * `run` se adjunta a cada recibo (versión de contrato, commit, hash del router) y lo pone quien
 * conoce el despliegue: stdio lo calcula con git, el Worker lo trae sellado del despliegue.
 */
export function createMcpHandler({ apiKey = '', run = null, engine = 'mcp', fetcher, now } = {}) {
  const throttle = makeThrottle(apiKey ? 110 : 350);

  async function callTool(params) {
    if (params?.name !== TOOL.name) return { error: [-32602, `Herramienta desconocida: ${params?.name}`] };
    const args = params.arguments ?? {};
    const extra = Object.keys(args).filter((k) => !(k in TOOL.inputSchema.properties));
    const query = args.query;
    const retmax = args.retmax ?? 0;
    const invalid = extra.length > 0 ? `argumentos no admitidos: ${extra.join(', ')}`
      : typeof query !== 'string' || query.trim() === '' ? 'query debe ser una cadena no vacía'
        : query.length > MCP_MAX_QUERY ? `query supera ${MCP_MAX_QUERY} caracteres`
          : !Number.isSafeInteger(retmax) || retmax < 0 || retmax > MCP_MAX_RETMAX
            ? `retmax debe ser un entero entre 0 y ${MCP_MAX_RETMAX}` : null;
    if (invalid) return { result: toolError({ error: invalid, result_count: null }) };

    await throttle();
    try {
      const receipt = await runExact(query, {
        retmax, apiKey, tool: 'pubmed-filters-mcp', engine,
        ...(fetcher ? { fetcher } : {}), ...(now ? { now } : {}),
      });
      const structured = { run, ...receipt };
      return { result: { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured, isError: false } };
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
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: [TOOL] });
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
