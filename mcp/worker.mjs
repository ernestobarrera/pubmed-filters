/**
 * MCP remoto en Cloudflare Workers (Streamable HTTP, versión 2025-06-18, sin estado).
 *
 * Una URL a la que ChatGPT, claude.ai u otro cliente MCP remoto se conectan sin instalar nada. No hay
 * servidor que mantener: Cloudflare ejecuta esta función en cada petición. Solo lee PubMed; no guarda
 * consultas, no escribe registros y no devuelve nunca ninguna clave.
 *
 * Secretos (`npx wrangler secret put <NOMBRE>`, nunca en el repositorio):
 *   ACCESS_KEY      obligatorio. Una o varias claves separadas por comas, cada una de 32 caracteres o
 *                   más: una por persona, para poder retirar el acceso a una sin cortárselo a todas. El
 *                   endpoint es /mcp/<clave>. Sin ninguna válida, el Worker no atiende (503).
 *   NCBI_API_KEY    opcional. Ver mcp/README.md antes de poner la tuya: la cuota es por clave.
 *   NCBI_EMAIL      opcional. Contacto que NCBI pide junto a `tool`; viaja a NCBI y a ningún otro sitio.
 *   ALLOWED_ORIGINS opcional. Orígenes de navegador admitidos, separados por comas. Por defecto, ninguno.
 *
 * Controles, todos de la revisión de Codex del 2026-10-08 y probados en mcp/test.mjs:
 *  - Origin: una petición de navegador de un origen no admitido se rechaza (403). Los clientes MCP
 *    remotos llaman de servidor a servidor y no lo envían; sin Origin se atiende.
 *  - MCP-Protocol-Version: si llega y no es una versión soportada, 400.
 *  - Un único mensaje JSON-RPC por petición: la 2025-06-18 no admite lotes (400).
 *  - Cuerpo leído por BYTES y cortado al pasar el límite, sin cargarlo entero antes de mirar (413).
 *
 * Sin estado a propósito: no hay sesiones ni flujo SSE (GET → 405). Así no hacen falta Durable Objects
 * ni almacenamiento, que es lo que lo mantiene en el plan gratuito y sin nada que cuidar.
 */

import { createMcpHandler, PROTOCOL_VERSIONS } from './protocol.mjs';
import buildInfo from './build-info.mjs';

export const MAX_BODY_BYTES = 64 * 1024;
export const MIN_ACCESS_KEY_LENGTH = 32;

const list = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const corsFor = (origin) => (origin ? {
  'access-control-allow-origin': origin,
  vary: 'origin',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version',
} : {});
const json = (body, status, cors) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...cors },
});
const rpcError = (code, message, status, cors) => json({ jsonrpc: '2.0', id: null, error: { code, message } }, status, cors);

/** Lee el cuerpo contando bytes y deja de leer en cuanto pasa del límite. Devuelve null si lo pasa. */
async function readBounded(request, limit) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

let handler = null;
let handlerKey = null;
const getHandler = (env) => {
  const key = `${env.NCBI_API_KEY ?? ''}\u0000${env.NCBI_EMAIL ?? ''}`;
  if (!handler || handlerKey !== key) {
    handler = createMcpHandler({
      apiKey: env.NCBI_API_KEY ?? '', email: env.NCBI_EMAIL ?? '', run: buildInfo, engine: 'mcp/worker.mjs',
      timeoutMs: 25000,
    });
    handlerKey = key;
  }
  return handler;
};

export default {
  async fetch(request, env = {}) {
    const keys = list(env.ACCESS_KEY);
    if (keys.length === 0 || keys.some((k) => k.length < MIN_ACCESS_KEY_LENGTH)) {
      return new Response(`ACCESS_KEY ausente o con alguna clave de menos de ${MIN_ACCESS_KEY_LENGTH} caracteres.`,
        { status: 503 });
    }
    const { pathname } = new URL(request.url);
    const match = /^\/mcp\/([^/]+)\/?$/.exec(pathname);
    // Cualquier otra ruta, o una clave que no está, es 404 sin pistas: no se anuncia qué hay detrás.
    if (!match || !keys.includes(match[1])) return new Response('Not found', { status: 404 });

    const origin = request.headers.get('origin');
    if (origin !== null && !list(env.ALLOWED_ORIGINS).includes(origin)) {
      return new Response('Origin not allowed', { status: 403 });
    }
    const cors = corsFor(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'POST, OPTIONS', ...cors } });
    }

    const version = request.headers.get('mcp-protocol-version');
    if (version !== null && !PROTOCOL_VERSIONS.includes(version)) {
      return rpcError(-32600, `MCP-Protocol-Version no soportada: ${version}. Soportadas: ${PROTOCOL_VERSIONS.join(', ')}`, 400, cors);
    }

    const text = await readBounded(request, MAX_BODY_BYTES);
    if (text === null) return rpcError(-32600, 'Petición demasiado grande', 413, cors);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return rpcError(-32700, 'JSON inválido', 400, cors);
    }
    if (Array.isArray(message)) {
      return rpcError(-32600, 'Lotes JSON-RPC no admitidos: un mensaje por petición (MCP 2025-06-18)', 400, cors);
    }

    const response = await getHandler(env)(message);
    return response ? json(response, 200, cors) : new Response(null, { status: 202, headers: cors });
  },
};
