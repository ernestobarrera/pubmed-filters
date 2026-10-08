/**
 * MCP remoto en Cloudflare Workers (transporte Streamable HTTP, sin estado).
 *
 * Una URL a la que ChatGPT, claude.ai u otro cliente MCP remoto se conectan sin instalar nada. No hay
 * servidor que mantener: Cloudflare ejecuta esta función en cada petición. Solo lee PubMed; no guarda
 * consultas, no escribe registros y no devuelve nunca la clave de NCBI.
 *
 * Secretos (se ponen con `npx wrangler secret put`, nunca en el repositorio):
 *   NCBI_API_KEY  opcional. Cuota de 10 peticiones/s en NCBI, en vez de 3 por IP compartida.
 *   ACCESS_KEY    obligatoria. El endpoint es /mcp/<ACCESS_KEY>: solo quien tenga la URL completa
 *                 puede usarlo, y la cuota de tu clave de NCBI no queda abierta a cualquiera. Sin ella
 *                 el Worker no atiende (503): cerrado por defecto, también el minuto que pasa entre el
 *                 primer despliegue y poner el secreto. Para abrirlo sin clave a propósito, ALLOW_OPEN=1.
 *
 * Sin estado a propósito: cada POST es independiente, no hay sesiones ni flujo SSE. El transporte lo
 * permite (el servidor puede contestar JSON y responder 405 al GET), y así no hacen falta Durable
 * Objects ni almacenamiento, que es lo que mantiene esto dentro del plan gratuito y sin nada que cuidar.
 */

import { createMcpHandler } from './protocol.mjs';
import buildInfo from './build-info.mjs';

const MAX_BODY = 64 * 1024;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, authorization',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...CORS },
});

let handler = null;
let handlerKey = null;
const getHandler = (env) => {
  const apiKey = env.NCBI_API_KEY ?? '';
  if (!handler || handlerKey !== apiKey) {
    handler = createMcpHandler({ apiKey, run: buildInfo, engine: 'mcp/worker.mjs' });
    handlerKey = apiKey;
  }
  return handler;
};

export default {
  async fetch(request, env = {}) {
    const { pathname } = new URL(request.url);
    if (!env.ACCESS_KEY && env.ALLOW_OPEN !== '1') {
      return new Response('Falta el secreto ACCESS_KEY: npx wrangler secret put ACCESS_KEY', { status: 503 });
    }
    const endpoint = env.ACCESS_KEY ? `/mcp/${env.ACCESS_KEY}` : '/mcp';
    // Cualquier otra ruta es 404, sin pistas: no se anuncia qué hay detrás.
    if (pathname !== endpoint && pathname !== `${endpoint}/`) return new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'POST, OPTIONS', ...CORS } });
    }

    const text = await request.text();
    if (text.length > MAX_BODY) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Petición demasiado grande' } }, 413);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }, 400);
    }

    const handle = getHandler(env);
    // Lotes: los admitía la versión 2025-03-26 del protocolo; se contestan uno a uno.
    if (Array.isArray(message)) {
      const responses = (await Promise.all(message.map((m) => handle(m)))).filter(Boolean);
      return responses.length ? json(responses) : new Response(null, { status: 202, headers: CORS });
    }
    const response = await handle(message);
    return response ? json(response) : new Response(null, { status: 202, headers: CORS });
  },
};
