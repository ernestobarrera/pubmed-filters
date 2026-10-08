#!/usr/bin/env node
/**
 * Pruebas del MCP, sin red: el protocolo (stdio y Worker comparten `createMcpHandler`) y el
 * transporte HTTP del Worker. PubMed se sustituye por las respuestas REALES de
 * scripts/fixtures/respuestas-pubmed.json, servidas byte a byte.
 *
 * Uso:  node mcp/test.mjs        Sale 0 si todo pasa.
 *
 * Lo que NO prueban: que un cliente concreto (ChatGPT, claude.ai) acepte el servidor. Eso se probó a
 * mano el 2026-10-08 con el cliente oficial del SDK de MCP (1.32.1), por stdio y por HTTP, contra
 * PubMed real; y se vuelve a probar al conectar cada cliente.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
await import('./stamp.mjs'); // el Worker importa build-info.mjs, que se genera al desplegar
const { createMcpHandler, TOOL, PROTOCOL_VERSIONS, MCP_MAX_RETMAX } = await import('./protocol.mjs');
const { default: worker } = await import('./worker.mjs');

const respuestas = JSON.parse(readFileSync(join(HERE, '..', 'scripts', 'fixtures', 'respuestas-pubmed.json'), 'utf8'));
const pass = [];
const fail = [];
const check = (id, ok, detail) => (ok ? pass : fail).push(`${id}  ${detail}`);

const enviadas = [];
const sirve = (cuerpo, status = 200) => async (url, init = {}) => {
  enviadas.push({ url: String(url), method: init.method, body: init.body?.toString() ?? '' });
  return { ok: status === 200, status, text: async () => cuerpo };
};
const llamada = (id, query, extra = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call',
  params: { name: TOOL.name, arguments: { query, ...extra } } });

// --- Protocolo ---------------------------------------------------------------------------------

const h = createMcpHandler({ fetcher: sirve(JSON.stringify(respuestas['consulta-valida'])), run: { contract_version: 'x' } });
const ini = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
const iniRara = await h({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
check('M1', ini.result.protocolVersion === '2025-03-26' && iniRara.result.protocolVersion === PROTOCOL_VERSIONS[0]
  && ini.result.capabilities.tools && ini.result.serverInfo.name === 'pubmed-filters-exact',
  'initialize negocia la versión del cliente si la conoce, y si no la más nueva propia');

const lista = await h({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
check('M2', lista.result.tools.length === 1 && lista.result.tools[0].name === 'pubmed_search_exact'
  && lista.result.tools[0].annotations.readOnlyHint === true
  && lista.result.tools[0].inputSchema.required.includes('query'),
  'una sola herramienta, de solo lectura, con query obligatoria');

check('M3', await h({ jsonrpc: '2.0', method: 'notifications/initialized' }) === null
  && await h({ jsonrpc: '2.0', id: 9, result: {} }) === null
  && (await h({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).error.code === -32601
  && (await h({ jsonrpc: '1.0', id: 5, method: 'ping' })).error.code === -32600
  && JSON.stringify((await h({ jsonrpc: '2.0', id: 6, method: 'ping' })).result) === '{}',
  'notificaciones y respuestas no se contestan; método desconocido -32601; JSON-RPC inválido -32600; ping');

// --- La herramienta: el mismo recibo y el mismo juicio que el CLI -------------------------------

const integridad = {};
for (const k of ['consulta-valida', 'mesh-inexistente', 'termino-descartado-con-resultados',
  'aviso-perdido-por-rettype-count', 'campo-invalido']) {
  enviadas.length = 0;
  const hk = createMcpHandler({ fetcher: sirve(JSON.stringify(respuestas[k])) });
  const r = await hk(llamada(10, respuestas[k].term));
  integridad[k] = r.result.structuredContent.status?.query_integrity;
  if (new URLSearchParams(enviadas[0]?.body).get('term') !== respuestas[k].term || enviadas[0]?.method !== 'POST') {
    integridad[k] = 'CONSULTA_ALTERADA';
  }
}
const esperado = { 'consulta-valida': 'verified', 'mesh-inexistente': 'failed',
  'termino-descartado-con-resultados': 'failed', 'aviso-perdido-por-rettype-count': 'unsupported',
  'campo-invalido': 'failed' };
const mal = Object.keys(esperado).filter((k) => integridad[k] !== esperado[k]);
check('M4', mal.length === 0,
  `la consulta llega intacta por POST y el juicio es el del ejecutor de referencia${mal.length ? ` — mal: ${JSON.stringify(integridad)}` : ''}`);

const recibo = (await h(llamada(11, '"Atherosclerosis"[Mesh]'))).result;
check('M5', recibo.isError === false && recibo.structuredContent.run.contract_version === 'x'
  && JSON.parse(recibo.content[0].text).raw_response_sha256 === recibo.structuredContent.raw_response_sha256,
  'el recibo va en structuredContent y, idéntico, como texto; lleva el sello del despliegue');

// Fallos: nunca un recuento de cero.
const e414 = (await createMcpHandler({ fetcher: sirve('', 414) })(llamada(12, 'x[tiab]'))).result;
const eIlegible = (await createMcpHandler({ fetcher: sirve(respuestas['ventana-superada']._raw) })(llamada(13, 'x[tiab]'))).result;
check('M6', e414.isError && e414.structuredContent.transport_failure === true && e414.structuredContent.result_count === null
  && eIlegible.isError && /9,999/.test(eIlegible.structuredContent.error) && eIlegible.structuredContent.result_count === null,
  'un 414 o el ERROR ilegible de PubMed son errores declarados con result_count null, nunca un cero');

enviadas.length = 0;
const argsMalos = await Promise.all([
  h(llamada(14, '')),
  h(llamada(15, 'x', { retmax: MCP_MAX_RETMAX + 1 })),
  h(llamada(16, 'x', { reescribir: true })),
  h(llamada(17, 'x'.repeat(20001))),
]);
const herramientaRara = await h({ jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'otra', arguments: {} } });
check('M7', argsMalos.every((r) => r.result.isError === true) && enviadas.length === 0 && herramientaRara.error.code === -32602,
  'argumentos inválidos se rechazan sin llamar a PubMed; herramienta desconocida -32602');

// Lo que la clave de NCBI no puede hacer: aparecer en el recibo.
enviadas.length = 0;
const conClave = (await createMcpHandler({ apiKey: 'CLAVE-SECRETA', fetcher: sirve(JSON.stringify(respuestas['consulta-valida'])) })(llamada(19, 'x[tiab]'))).result;
check('M8', new URLSearchParams(enviadas[0].body).get('api_key') === 'CLAVE-SECRETA'
  && !JSON.stringify(conClave).includes('CLAVE-SECRETA') && conClave.structuredContent.request.api_key_used === true,
  'la clave de NCBI viaja a NCBI y no aparece en ningún recibo');

// --- Transporte HTTP del Worker ------------------------------------------------------------------

const realFetch = globalThis.fetch;
globalThis.fetch = sirve(JSON.stringify(respuestas['consulta-valida']));
const env = { ACCESS_KEY: 'k123' };
const pedir = (path, init = {}) => worker.fetch(new Request(`https://w.example${path}`, init), env);
const post = (path, body) => pedir(path, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body) });
try {
  const rutas = await Promise.all([pedir('/'), post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }),
    post('/mcp/otra', { jsonrpc: '2.0', id: 1, method: 'ping' }), pedir('/mcp/k123')]);
  check('W1', rutas.map((r) => r.status).join() === '404,404,404,405',
    'sin la clave de acceso todo es 404; GET en el endpoint es 405 (sin flujo SSE)');

  const ok = await post('/mcp/k123', llamada(1, '"Atherosclerosis"[Mesh]'));
  const okBody = await ok.json();
  const notif = await post('/mcp/k123', { jsonrpc: '2.0', method: 'notifications/initialized' });
  const lote = await (await post('/mcp/k123', [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'x' }])).json();
  const roto = await post('/mcp/k123', '{no es json');
  const enorme = await post('/mcp/k123', JSON.stringify(llamada(1, 'x'.repeat(70000))));
  const opciones = await pedir('/mcp/k123', { method: 'OPTIONS' });
  check('W2', ok.status === 200 && ok.headers.get('content-type') === 'application/json'
    && okBody.result.structuredContent.engine === 'mcp/worker.mjs'
    && notif.status === 202 && Array.isArray(lote) && lote.length === 1
    && roto.status === 400 && enorme.status === 413 && opciones.status === 204,
    'POST devuelve JSON; notificación 202; lote; JSON roto 400; cuerpo enorme 413; OPTIONS 204');

  const sinClave = await worker.fetch(new Request('https://w.example/mcp', { method: 'POST', body: '{}' }), {});
  const abierto = await worker.fetch(new Request('https://w.example/mcp', { method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }), { ALLOW_OPEN: '1' });
  check('W3', sinClave.status === 503 && abierto.status === 200,
    'sin ACCESS_KEY el Worker no atiende (503): cerrado por defecto; abrirlo exige ALLOW_OPEN=1 explícito');
} finally {
  globalThis.fetch = realFetch;
}

for (const l of pass) console.log(`  pass  ${l}`);
for (const l of fail) console.log(`  FAIL  ${l}`);
console.log(`\n${pass.length} pass / ${fail.length} fail`);
process.exit(fail.length === 0 ? 0 : 1);
