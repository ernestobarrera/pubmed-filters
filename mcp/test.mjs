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
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { deploymentEnvironmentError } = await import('./stamp.mjs'); // genera el sello local
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

// El comando público empieza por el sellador. Se prueba la negativa en procesos reales sin
// ejecutar Wrangler ni utilizar credenciales: ni siquiera debe escribir el sello existente.
const deployScript = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).scripts.deploy;
const cleanEnv = { ...process.env };
delete cleanEnv.CLOUDFLARE_API_TOKEN;
delete cleanEnv.CLOUDFLARE_ACCOUNT_ID;
const fixtureAccount = 'a'.repeat(32);
const stampBefore = readFileSync(join(HERE, 'build-info.mjs'));
const deniedDeploys = [
  [cleanEnv, 'CLOUDFLARE_API_TOKEN'],
  [{ ...cleanEnv, CLOUDFLARE_ACCOUNT_ID: fixtureAccount }, 'CLOUDFLARE_API_TOKEN'],
  [{ ...cleanEnv, CLOUDFLARE_API_TOKEN: 'fixture-not-a-real-token' }, 'CLOUDFLARE_ACCOUNT_ID'],
  [{ ...cleanEnv, CLOUDFLARE_API_TOKEN: 'fixture-not-a-real-token', CLOUDFLARE_ACCOUNT_ID: 'invalid' },
    'CLOUDFLARE_ACCOUNT_ID'],
].map(([env, field]) => {
  const child = spawnSync(process.execPath, [join(HERE, 'stamp.mjs'), '--deploy'],
    { cwd: HERE, env, encoding: 'utf8' });
  return child.status === 1 && child.stderr.includes(field) && !child.stdout.includes('sellado:')
    && !`${child.stdout}${child.stderr}`.includes('fixture-not-a-real-token');
});
check('D1', /^node stamp\.mjs --deploy\s*&&\s*wrangler deploy$/.test(deployScript)
  && deniedDeploys.every(Boolean) && stampBefore.equals(readFileSync(join(HERE, 'build-info.mjs')))
  && deploymentEnvironmentError({ CLOUDFLARE_API_TOKEN: 'fixture-not-a-real-token',
    CLOUDFLARE_ACCOUNT_ID: fixtureAccount }) === null,
  'sin token e ID explícitos se rechaza antes del sellado y Wrangler; sin valores secretos en la salida');

// --- Protocolo ---------------------------------------------------------------------------------

const h = createMcpHandler({ fetcher: sirve(JSON.stringify(respuestas['consulta-valida'])), run: { contract_version: 'x' } });
const ini = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
const iniRara = await h({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
const iniPropia = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
check('M1', iniPropia.result.protocolVersion === '2025-06-18' && ini.result.protocolVersion === '2025-06-18'
  && iniRara.result.protocolVersion === '2025-06-18' && PROTOCOL_VERSIONS.join() === '2025-06-18'
  && ini.result.capabilities.tools && ini.result.serverInfo.name === 'pubmed-filters-exact',
  'anuncia solo la versión que cumple (2025-06-18) y la ofrece a quien pida otra');

const lista = await h({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
check('M2', lista.result.tools.map((t) => t.name).join() === 'pubmed_search_exact,pubmed_fetch_exact,pubmed_summary_exact'
  && lista.result.tools.every((t) => t.annotations.readOnlyHint === true)
  && lista.result.tools[0].inputSchema.required.includes('query'),
  'sin catálogo, buscar, leer y cribar por PMID: de solo lectura, con query obligatoria');

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

const pageResponse = respuestas['restricciones-ajustadas'].esearchresult;
const hardenedCases = [
  [{ count: '7', querytranslation: ' \t\n ' }, 'unsupported'],
  [{ ...pageResponse, warninglist: { outputmessages: [
    pageResponse.warninglist.outputmessages[0] + '. A term was ignored.'] } }, 'failed'],
  [pageResponse, 'verified'],
];
const hardenedReceipts = await Promise.all(hardenedCases.map(async ([response, expectedStatus]) => {
  const handler = createMcpHandler({ fetcher: sirve(JSON.stringify({ esearchresult: response })) });
  const result = (await handler(llamada(22, 'asthma[tiab]'))).result.structuredContent;
  return result.status.query_integrity === expectedStatus && result.querytranslation === response.querytranslation
    && JSON.stringify(result.warninglist) === JSON.stringify(response.warninglist ?? null);
}));
check('M11', hardenedReceipts.every(Boolean),
  'los casos sintéticos endurecidos llegan al recibo sin alterar los diagnósticos; la paginación real sigue verificada');

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

// El contacto para NCBI, igual que la clave: viaja a NCBI y a ningún otro sitio.
enviadas.length = 0;
const conEmail = (await createMcpHandler({ email: 'contacto@ejemplo.invalid',
  fetcher: sirve(JSON.stringify(respuestas['consulta-valida'])) })(llamada(20, 'x[tiab]'))).result;
check('M9', new URLSearchParams(enviadas[0].body).get('email') === 'contacto@ejemplo.invalid'
  && !JSON.stringify(conEmail).includes('contacto@ejemplo.invalid') && conEmail.structuredContent.request.email_used === true,
  'el email de contacto viaja a NCBI y no aparece en ningún recibo');

// Una petición colgada se corta y es un error declarado, nunca un recuento; y la cola tiene fondo.
// Como una conexión real colgada: algo mantiene vivo el proceso hasta que la señal la corta.
// (`AbortSignal.timeout` no lo mantiene por sí solo; un socket abierto, sí.)
const colgado = async (url, init = {}) => new Promise((resolve, reject) => {
  const socket = setTimeout(() => resolve({ ok: true, status: 200, text: async () => '{}' }), 10000);
  init.signal?.addEventListener('abort', () => { clearTimeout(socket); reject(init.signal.reason); });
});
const eTiempo = (await createMcpHandler({ fetcher: colgado, timeoutMs: 50 })(llamada(21, 'x[tiab]'))).result;
const lento = createMcpHandler({ fetcher: sirve(JSON.stringify(respuestas['consulta-valida'])), maxQueueMs: 1000 });
const enCola = await Promise.all(Array.from({ length: 12 }, (_, i) => lento(llamada(100 + i, 'x[tiab]'))));
const ocupadas = enCola.filter((r) => /SERVICIO_OCUPADO/.test(r.result.structuredContent.error ?? ''));
check('M10', eTiempo.isError && eTiempo.structuredContent.result_count === null
  && ocupadas.length > 0 && ocupadas.every((r) => r.result.isError && r.result.structuredContent.result_count === null),
  `tiempo agotado = error declarado sin recuento; con la cola llena se rechaza (${ocupadas.length} de 12) en vez de acumular`);

// --- Fuente simbólica: catálogo, filtro canónico y fidelidad (1.11.0) ---------------------------
// Medido el 2026-10-16: desde ChatGPT, 17 de 48 filtros no se podían encontrar, y cada filtro había
// que extraerlo a mano del .txt, que es donde la suite documenta los fallos caros.

const { buildFilterBundle } = await import('../scripts/filter-source.mjs');
const { parseFilter } = await import('../scripts/parse-filter.mjs');
const { CATALOG_TOOL, GET_FILTER_TOOL } = await import('./protocol.mjs');
const RAIZ_REPO = join(HERE, '..');
const paquete = await buildFilterBundle(RAIZ_REPO);
const conFuente = createMcpHandler({ fetcher: sirve(JSON.stringify(respuestas['consulta-valida'])), filters: paquete });
const usar = (id, name, args) => conFuente({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

const listaFuente = (await conFuente({ jsonrpc: '2.0', id: 30, method: 'tools/list' })).result.tools;
const iniFuente = (await conFuente({ jsonrpc: '2.0', id: 31, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result;
check('M12', listaFuente.map((t) => t.name).join() === 'pubmed_search_exact,pubmed_filter_catalog,pubmed_get_filter,pubmed_fetch_exact,pubmed_summary_exact'
  && listaFuente.every((t) => t.annotations.readOnlyHint === true)
  && /pubmed_filter_catalog/.test(iniFuente.instructions) && !/pubmed_filter_catalog/.test(ini.result.instructions),
  'con el paquete de filtros anuncia catálogo y extracción, de solo lectura; sin él, solo ejecuta y no lo promete');

enviadas.length = 0;
const cat = (await usar(32, CATALOG_TOOL.name, {})).result.structuredContent;
const catExcl = (await usar(33, CATALOG_TOOL.name, { role: 'exclusion' })).result.structuredContent;
const catRev = (await usar(34, CATALOG_TOOL.name, { include_journals: true })).result.structuredContent;
check('M13', cat.filters.length === 48 && cat.filters.every((f) => f.role && f.title && f.description)
  && catExcl.filters.length === 3 && catExcl.filters.every((f) => f.exclusion === true)
  && catRev.journal_lists?.length === 72 && cat.journal_lists === undefined
  && typeof cat.guidance.roles?.population_setting?.how === 'string' && cat.catalog_sha256 === paquete.catalog_sha256
  && enviadas.length === 0,
  'el catálogo lista los 48 filtros con papel y la guía de composición, filtra por papel y no llama a PubMed');

// Un filtro multilínea: el fallo que más caro ha salido es quedarse con la primera línea.
const multilinea = paquete.catalog.filters.map((f) => f.path)
  .find((p) => readFileSync(join(RAIZ_REPO, p), 'utf8').split('@@@FILTER_METADATA@@@')[0].split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#')).length > 1);
const fMulti = (await usar(35, GET_FILTER_TOOL.name, { path: multilinea })).result.structuredContent;
const fHumans = (await usar(36, GET_FILTER_TOOL.name, { path: 'filters/scope/humans.txt' })).result.structuredContent;
const fRevista = (await usar(37, GET_FILTER_TOOL.name, { path: 'jnl_primary_health_care' })).result.structuredContent;
const fNada = (await usar(38, GET_FILTER_TOOL.name, { path: 'filters/scope/inventado.txt' })).result;
const jsRev = readFileSync(join(RAIZ_REPO, 'journal_filters_data.js'), 'utf8');
check('M14', Boolean(multilinea) && fMulti.query === parseFilter(readFileSync(join(RAIZ_REPO, multilinea), 'utf8'))
  && !fMulti.query.includes('@@@') && !fMulti.query.includes('"validation"')
  && fHumans.exclusion === true && /NOT/.test(fHumans.how_to_compose) && /Never with AND/.test(fHumans.how_to_compose)
  && fRevista.source === 'journal_filters_data.js' && jsRev.includes(fRevista.query) && fRevista.role === 'editorial'
  && fNada.isError === true && /no lo reconstruyas/.test(fNada.structuredContent.error),
  `el filtro sale entero por el parser de referencia (${multilinea}), la exclusión dice cómo componerse, la revista sale del .js, y lo que no existe es error`);

const qT = paquete.filters['filters/clinical/deprescription.txt'].query;
const qH = paquete.filters['filters/scope/humans.txt'].query;
const fid = async (id, query, filtersUsed) => (await conFuente(llamada(id, query, { filters_used: filtersUsed }))).result.structuredContent;
const literal = await fid(40, `(asthma[tiab]) AND (${qT})`, ['filters/clinical/deprescription.txt']);
// Un salto de línea donde había un espacio no cambia lo que PubMed ejecuta; quitar un término, sí.
const conSaltos = await fid(41, `(asthma[tiab]) AND (${qT.replace(' ', '\n ')})`, ['filters/clinical/deprescription.txt']);
const sinTermino = qT.replace(/"[^"]+"\[[A-Za-z]+\]\|/, '');
const reconstruido = await fid(42, `(asthma[tiab]) AND (${sinTermino})`, ['filters/clinical/deprescription.txt']);
const exclusionAnd = await fid(43, `(asthma[tiab]) AND (${qH})`, ['filters/scope/humans.txt']);
const exclusionNot = await fid(44, `(asthma[tiab]) ${qH}`, ['filters/scope/humans.txt']);
const inventado = await fid(45, 'asthma[tiab]', ['filters/scope/inventado.txt']);
enviadas.length = 0;
const sinFuente = (await h(llamada(46, 'asthma[tiab]', { filters_used: ['filters/scope/humans.txt'] }))).result;
check('M15', sinTermino !== qT && qT.includes(' ') && literal.status.filter_fidelity === 'verified' && conSaltos.status.filter_fidelity === 'verified'
  && reconstruido.status.filter_fidelity === 'failed' && /modificado o reconstruido/.test(reconstruido.filter_fidelity[0].problem)
  && exclusionAnd.status.filter_fidelity === 'failed' && /AND/.test(exclusionAnd.filter_fidelity[0].problem)
  && exclusionNot.status.filter_fidelity === 'verified' && inventado.status.filter_fidelity === 'failed'
  && literal.status.query_integrity === 'verified' && literal.catalog_sha256 === paquete.catalog_sha256
  && sinFuente.isError === true && enviadas.length === 0,
  'filter_fidelity: literal o con saltos de línea, verified; un término quitado, una exclusión con AND o un filtro inexistente, failed; sin catálogo no se finge');

// Los vectores de la revisión de Codex del 2026-10-16: nombres heredados del prototipo que daban
// verified a un filtro inexistente, y exclusiones mal compuestas que pasaban por anidamiento o porque
// una aparición correcta tapaba otra incorrecta.
const HEREDADOS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
// allSettled: una excepción es justo el fallo que se vigila (la extracción rompía), y tiene que caer M16,
// no el proceso entero.
const valor = (s) => (s.status === 'fulfilled' ? s.value : null);
const heredadosBusqueda = (await Promise.allSettled(HEREDADOS.map((n, i) => fid(60 + i, 'asthma[tiab] OR undefined[tiab]', [n])))).map(valor);
const heredadosExtraccion = (await Promise.allSettled(HEREDADOS.map((n, i) => usar(70 + i, GET_FILTER_TOOL.name, { path: n })))).map(valor);
check('M16', heredadosBusqueda.every((r) => r?.status?.filter_fidelity === 'failed' && r.filter_fidelity?.[0]?.found_literal === false)
  && heredadosExtraccion.every((r) => r?.result?.isError === true && /no lo reconstruyas/.test(r.result.structuredContent.error)),
  `nombres heredados (${HEREDADOS.join(', ')}): ni se dan por presentes ni rompen la extracción`);

const qPearls = paquete.filters['filters/scope/pearls.txt'].query;
const excl = {
  correcta: await fid(80, `(asthma[tiab]) ${qH}`, ['filters/scope/humans.txt']),
  conSalto: await fid(81, `(asthma[tiab]) AND\n(${qH})`, ['filters/scope/humans.txt']),
  dosParentesis: await fid(82, `(asthma[tiab]) AND ((${qH}))`, ['filters/scope/humans.txt']),
  tresParentesis: await fid(83, `(asthma[tiab]) AND (((${qH})))`, ['filters/scope/humans.txt']),
  correctaTapaMala: await fid(84, `((asthma[tiab]) ${qH}) OR ((asthma[tiab]) AND (${qH}))`, ['filters/scope/humans.txt']),
  conOR: await fid(85, `(asthma[tiab]) OR (${qH})`, ['filters/scope/humans.txt']),
  alPrincipio: await fid(86, `${qH}`, ['filters/scope/humans.txt']),
  dentroDePerlas: await fid(87, `(asthma[tiab]) AND (${qPearls})`, ['filters/scope/pearls.txt', 'filters/scope/humans.txt']),
};
const malas = ['conSalto', 'dosParentesis', 'tresParentesis', 'correctaTapaMala', 'conOR', 'alPrincipio'];
check('M17', excl.correcta.status.filter_fidelity === 'verified' && excl.dentroDePerlas.status.filter_fidelity === 'verified'
  && qPearls.includes(qH) && malas.every((k) => excl[k].status.filter_fidelity === 'failed'),
  `exclusión: literal tras un operando, verified (también dentro de pearls); tras AND u OR con saltos o paréntesis anidados, al inicio, o mal compuesta después de una buena, failed — estados: ${JSON.stringify(Object.fromEntries(Object.entries(excl).map(([k, v]) => [k, v.status.filter_fidelity])))}`);

// --- Registro de selección en el recibo (1.12.0) -----------------------------------------------
// Medido el 2026-10-17/18 con ChatGPT: el registro se escribió después de los resultados en cinco de
// cinco casos. El recibo lo devuelve con la hora del servidor al llegar, ANTES de PubMed, y lo contrasta
// con catálogo y filters_used. Es declaración del agente: nunca cambia query_integrity ni filter_fidelity.

const { sha256 } = await import('../scripts/exact-core.mjs');
let tic = Date.parse('2026-10-18T10:00:00.000Z');
const reloj = () => new Date(tic += 1000);
const conRegistro = createMcpHandler({ fetcher: sirve(JSON.stringify(respuestas['consulta-valida'])), filters: paquete, now: reloj });
const buscar = async (id, query, extra) => (await conRegistro(llamada(id, query, extra))).result;
const DEP = 'filters/clinical/deprescription.txt';
const registro = (cambios = {}) => ({
  plan_ref: 'plan-1/r1',
  facets: [{ facet: 'benzodiazepines', role_in_question: 'core' }, { facet: 'deprescribing', role_in_question: 'concept' }],
  filters: [{ path: DEP, decision: 'used', role_used: 'concept', reason: 'OR inside the deprescribing concept' },
    { path: 'filters/scope/geriatrics_sensible.txt', decision: 'discarded', reason: 'older people is core vocabulary' }],
  pass: { pass_id: 'p1', purpose: 'core with concept filter', unit_claim: 'effect of deprescribing' },
  ...cambios,
});
const qDep = `(asthma[tiab]) AND (${qT})`;
const conFecha = `${qDep} AND 2015:2026[dp]`;
const r = {
  bueno: await buscar(90, qDep, { filters_used: [DEP], selection_record: registro() }),
  ausente: await buscar(91, qDep, { filters_used: [DEP] }),
  descartadoPeroEnviado: await buscar(92, qDep, { filters_used: [DEP], selection_record: registro({
    filters: [{ path: DEP, decision: 'discarded', reason: 'not needed here' }] }) }),
  usadoPeroNoEnviado: await buscar(93, qDep, { selection_record: registro() }),
  inventado: await buscar(94, qDep, { filters_used: [DEP], selection_record: registro({
    filters: [...registro().filters, { path: 'filters/scope/inventado.txt', decision: 'discarded', reason: 'not in catalog' }] }) }),
  fechaSinOrigen: await buscar(95, conFecha, { filters_used: [DEP], selection_record: registro() }),
  fechaAgenteSola: await buscar(96, conFecha, { filters_used: [DEP], selection_record: registro({
    date_window: { limit: '2015:2026[dp]', origin: 'agent_policy' } }) }),
  fechaAgenteConPasada: await buscar(97, conFecha, { filters_used: [DEP], selection_record: registro({
    date_window: { limit: '2015:2026[dp]', origin: 'agent_policy', unrestricted_pass_id: 'p0' } }) }),
  fechaUsuario: await buscar(98, conFecha, { filters_used: [DEP], selection_record: registro({
    date_window: { limit: '2015:2026[dp]', origin: 'user' },
    known_pmids: [{ pmid: '24733354', origin: 'model_prior_knowledge' }, { pmid: '30422193', origin: 'undetermined' }] }) }),
};
const est = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.structuredContent.status?.selection_record]));
const bueno = r.bueno.structuredContent;
const debenFallar = ['descartadoPeroEnviado', 'usadoPeroNoEnviado', 'inventado', 'fechaSinOrigen', 'fechaAgenteSola'];
check('M18', est.bueno === 'declared' && est.ausente === 'not_declared' && r.ausente.structuredContent.selection_record === undefined
  && debenFallar.every((k) => est[k] === 'inconsistent' && r[k].structuredContent.selection_record.problems.length > 0)
  && est.fechaAgenteConPasada === 'declared' && est.fechaUsuario === 'declared'
  && /date_window_check/.test(r.fechaAgenteSola.structuredContent.selection_record.problems.join(' '))
  && bueno.selection_record.declared_by === 'agent' && Date.parse(bueno.selection_record.received_at) < Date.parse(bueno.executed_at)
  && bueno.selection_record.sha256 === await sha256(JSON.stringify(registro()))
  && JSON.stringify(bueno.selection_record.record) === JSON.stringify(registro())
  && Object.values(r).every((v) => v.isError === false && v.structuredContent.status.query_integrity === 'verified')
  && r.descartadoPeroEnviado.structuredContent.status.filter_fidelity === 'verified',
  `registro en el recibo: hora del servidor anterior a PubMed, huella y contraste con catálogo, filters_used y ventana de fecha; sin tocar la integridad — estados: ${JSON.stringify(est)}`);

// Los contraejemplos de la revisión de Codex del 2026-10-18 (13-revision-codex-delta-1.12): fechas que
// el detector no veía o veía donde no había, una ventana «de filtro» sin filtro, una ruta enviada que no
// existe, una decisión doble y una pasada sin ventana que era la misma.
const PEARLS = 'filters/scope/pearls.txt';
const qPearlsCore = `(asthma[tiab]) AND (${qPearls})`;
const conPerlas = (cambios = {}) => registro({ filters: [{ path: PEARLS, decision: 'used', role_used: 'editorial', reason: 'clinical pearls lane' }], ...cambios });
const agente = (pass = 'p0') => registro({ date_window: { limit: 'window', origin: 'agent_policy', unrestricted_pass_id: pass } });
const c = {
  epdatSinVentana: await buscar(120, `${qDep} AND 2015:2026[epdat]`, { filters_used: [DEP], selection_record: registro() }),
  ppdatSinVentana: await buscar(121, `${qDep} AND 2015:2026[ppdat]`, { filters_used: [DEP], selection_record: registro() }),
  espaciosSinVentana: await buscar(122, `${qDep} AND 2015:2026[ dp ]`, { filters_used: [DEP], selection_record: registro() }),
  largaSinVentana: await buscar(123, `${qDep} AND 2015:2026[Date - MeSH]`, { filters_used: [DEP], selection_record: registro() }),
  entreComillas: await buscar(124, `${qDep} AND "[dp]"[tiab]`, { filters_used: [DEP], selection_record: registro() }),
  epdatConPasada: await buscar(125, `${qDep} AND 2015:2026[epdat]`, { filters_used: [DEP], selection_record: agente() }),
  autorreferencia: await buscar(126, conFecha, { filters_used: [DEP], selection_record: agente('p1') }),
  filtroSinFiltro: await buscar(127, 'asthma[tiab] AND 2015:2026[dp]', { selection_record: registro({ filters: [],
    date_window: { limit: '2015:2026[dp]', origin: 'filter' } }) }),
  filtroSinFecha: await buscar(128, 'asthma[tiab]', { selection_record: registro({ filters: [], date_window: { limit: 'x', origin: 'filter' } }) }),
  filtroReal: await buscar(129, qPearlsCore, { filters_used: [PEARLS], selection_record: conPerlas({ date_window: { limit: 'last 5 years', origin: 'filter' } }) }),
  filtroRealMasAgente: await buscar(130, `${qPearlsCore} AND 2015:2026[dp]`, { filters_used: [PEARLS],
    selection_record: conPerlas({ date_window: { limit: 'last 5 years', origin: 'filter' } }) }),
  enviadoInexistente: await buscar(131, 'asthma[tiab]', { filters_used: ['filters/scope/inventado.txt'], selection_record: registro({ filters: [] }) }),
  decisionDoble: await buscar(132, qDep, { filters_used: [DEP], selection_record: registro({
    filters: [...registro().filters, { path: DEP, decision: 'discarded', reason: 'and also not' }] }) }),
  usadoEnOtraPasada: await buscar(133, 'asthma[tiab]', { selection_record: registro({
    filters: [{ path: DEP, decision: 'used', pass_id: 'p2', reason: 'used in the concept pass p2' }] }) }),
  papelDeFaceta: await buscar(134, qDep, { filters_used: [DEP], selection_record: registro({
    filters: [{ path: DEP, decision: 'used', role_used: 'core', reason: 'facet role by mistake' }] }) }),
};
const ec = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.structuredContent.status?.selection_record]));
const incoherentes = ['epdatSinVentana', 'ppdatSinVentana', 'espaciosSinVentana', 'largaSinVentana', 'autorreferencia',
  'filtroSinFiltro', 'filtroSinFecha', 'filtroRealMasAgente', 'enviadoInexistente', 'decisionDoble', 'papelDeFaceta'];
const coherentes = ['entreComillas', 'epdatConPasada', 'filtroReal', 'usadoEnOtraPasada'];
check('M20', incoherentes.every((k) => ec[k] === 'inconsistent') && coherentes.every((k) => ec[k] === 'declared')
  && Object.values(c).every((v) => v.isError === false && v.structuredContent.status.query_integrity === 'verified')
  && c.enviadoInexistente.structuredContent.status.filter_fidelity === 'failed',
  `fechas largas, con espacios o entre comillas; ventana «de filtro» solo con un filtro con fecha embebida y sin otra ventana fuera; ruta enviada inexistente, decisión doble, autorreferencia y papel de faceta como papel de filtro — estados: ${JSON.stringify(ec)}`);

enviadas.length = 0;
const malos = {
  sinFacetas: registro({ facets: [] }),
  claveAjena: { ...registro(), justification_after_results: 'x' },
  papelInventado: registro({ facets: [{ facet: 'x', role_in_question: 'core_and_more' }] }),
  origenInventado: registro({ known_pmids: [{ pmid: '123', origin: 'a review I recall' }] }),
  pmidMalo: registro({ known_pmids: [{ pmid: 'PMC123', origin: 'user' }] }),
  enorme: registro({ filters: Array.from({ length: 60 }, (_, i) => ({ path: `filters/x${i}.txt`, decision: 'discarded', reason: 'y'.repeat(400) })) }),
  noObjeto: 'facets: core',
};
const rechazos = await Promise.all(Object.values(malos).map((rec, i) => buscar(100 + i, qDep, { filters_used: [DEP], selection_record: rec })));
const sinCatalogo = (await h(llamada(110, 'asthma[tiab]', { selection_record: registro() }))).result;
check('M19', rechazos.every((x) => x.isError === true && x.structuredContent.result_count === null)
  && sinCatalogo.isError === true && /catálogo/.test(sinCatalogo.structuredContent.error) && enviadas.length === 0,
  'un registro mal formado (vacío, con claves ajenas, papeles u orígenes inventados, PMID inválido, enorme o no objeto) o sin catálogo se rechaza sin llamar a PubMed');

// --- Orden, páginas y recorrido de lectura (1.13.0) ------------------------------------------------
// Medido el 2026-10-17/18: ESearch devuelve primero lo más reciente y la superficie leía los primeros N
// como si fueran el conjunto. El MCP deja pedir otro orden y otra página, valida ambos en su propia
// interfaz (no solo en el ejecutor) y el registro declara cómo se leerá la pasada.

const { ESEARCH_WINDOW } = await import('./protocol.mjs');
const conPagina = (structured) => createMcpHandler({ fetcher: sirve(JSON.stringify({ esearchresult: structured })) });
enviadas.length = 0;
const sinOrden = (await conPagina({ count: '25', idlist: ['1', '2'], querytranslation: 'x[tiab]' })(llamada(140, 'x[tiab]', { retmax: 2 }))).result.structuredContent;
const cuerpoSinOrden = new URLSearchParams(enviadas[0]?.body ?? '');
enviadas.length = 0;
const conOrden = (await conPagina({ count: '25', idlist: ['3', '4'], querytranslation: 'x[tiab]' })(llamada(141, 'x[tiab]', { retmax: 2, retstart: 2, sort: 'relevance' }))).result.structuredContent;
const cuerpoConOrden = new URLSearchParams(enviadas[0]?.body ?? '');
enviadas.length = 0;
const paginaMala = await Promise.all([
  { retstart: -1 }, { retstart: ESEARCH_WINDOW }, { retstart: 2.5 }, { retstart: null }, { sort: 'pub_date' }, { sort: null },
].map((extra, i) => h(llamada(150 + i, 'x[tiab]', { retmax: 2, ...extra }))));
const props = TOOL.inputSchema.properties;
check('M21', !cuerpoSinOrden.has('sort') && !cuerpoSinOrden.has('retstart') && sinOrden.request.sort === null
  && sinOrden.next_retstart === 2 && sinOrden.next_retstart_reason === null
  && cuerpoConOrden.get('sort') === 'relevance' && cuerpoConOrden.get('retstart') === '2'
  && conOrden.request.sort === 'relevance' && conOrden.request.retstart === 2 && conOrden.page?.first === 3 && conOrden.next_retstart === 4
  && paginaMala.every((x) => x.result.isError === true && x.result.structuredContent.result_count === null
    && !Object.hasOwn(x.result.structuredContent, 'sent_query'))
  && enviadas.length === 0
  && props.sort?.enum?.join() === 'relevance' && props.retstart?.maximum === ESEARCH_WINDOW - 1
  && /next_retstart/.test(TOOL.description) && /not the set/.test(TOOL.description),
  'sort y retstart viajan por POST solo si se piden y el recibo los refleja con su continuación; fuera de rango se rechazan en la interfaz del MCP, sin llamar a PubMed');

const RECORRIDOS = Object.keys(JSON.parse(readFileSync(join(HERE, '..', 'neurosymbolic_router.json'), 'utf8')).reading_and_drilldown.reading_path)
  .filter((k) => k !== 'rule');
const conPase = (cambios) => registro({ pass: { ...registro().pass, ...cambios } });
const rl = {
  sinRecorrido: await buscar(160, qDep, { filters_used: [DEP], selection_record: registro() }),
  completo: await buscar(161, qDep, { filters_used: [DEP], selection_record: conPase({ reading_path: 'complete_retrieval' }) }),
  exploracion: await buscar(162, qDep, { filters_used: [DEP], selection_record: conPase({ reading_path: 'exploration_only' }) }),
  focalizadaConMotivo: await buscar(163, qDep, { filters_used: [DEP], selection_record: conPase({
    reading_path: 'focused_selection', selection_reason: 'the 59 synthesis records, retrieved whole' }) }),
  focalizadaSinMotivo: await buscar(164, qDep, { filters_used: [DEP], selection_record: conPase({ reading_path: 'focused_selection' }) }),
  focalizadaYDescartado: await buscar(165, qDep, { filters_used: [DEP], selection_record: registro({
    filters: [{ path: DEP, decision: 'discarded', reason: 'not needed here' }],
    pass: { ...registro().pass, reading_path: 'focused_selection', selection_reason: 'trials only' } }) }),
};
enviadas.length = 0;
const rlMalos = await Promise.all([
  conPase({ reading_path: 'read_everything' }), conPase({ reading_path: 'focused_selection', selection_reason: 'ok' }),
].map((rec, i) => buscar(170 + i, qDep, { filters_used: [DEP], selection_record: rec })));
const sr = (k) => rl[k].structuredContent.selection_record;
const st = (k) => rl[k].structuredContent.status.selection_record;
check('M22', RECORRIDOS.join() === TOOL.inputSchema.properties.selection_record.properties.pass.properties.reading_path.enum.join()
  && st('sinRecorrido') === 'declared' && sr('sinRecorrido').notes.join() === 'reading_path no declarado' && sr('sinRecorrido').problems.length === 0
  && ['completo', 'exploracion', 'focalizadaConMotivo'].every((k) => st(k) === 'declared' && sr(k).notes.length === 0)
  && st('focalizadaSinMotivo') === 'inconsistent' && /selection_reason/.test(sr('focalizadaSinMotivo').problems.join(' '))
  && st('focalizadaYDescartado') === 'inconsistent' && sr('focalizadaYDescartado').problems.length === 1
  && Object.values(rl).every((v) => v.isError === false && v.structuredContent.status.query_integrity === 'verified')
  && rlMalos.every((x) => x.isError === true) && enviadas.length === 0,
  `recorrido de lectura: el enumerado es el del router; sin declarar, el registro sigue declared con una nota aparte; focused_selection exige su motivo; no oculta otros problemas; un recorrido inventado o un motivo de menos de 3 caracteres se rechazan — estados: ${JSON.stringify(Object.fromEntries(Object.keys(rl).map((k) => [k, st(k)])))}`);

// --- Lectura por PMID con recibo (1.14.0, especificación 29-) --------------------------------------
// Medido en las pruebas de superficie del 21-23/10: PMID pedidos contados como abstracts conservados, y un
// tramo final de un texto marcado «no truncado». Aquí: esquema estricto antes de NCBI, la misma cola que la
// búsqueda, el mismo run y un recibo que cabe en su presupuesto en las dos representaciones.

const { FETCH_TOOL } = await import('./protocol.mjs');
const { MAX_STRUCTURED_BYTES } = await import('../scripts/fetch-core.mjs');
const xmlLectura = (ids, n = 3000) => `<?xml version="1.0" ?>\n<PubmedArticleSet>${ids.map((p) => `<PubmedArticle><MedlineCitation><PMID Version="1">${p}</PMID>`
  + `<Article><Journal><JournalIssue><PubDate><Year>2021</Year></PubDate></JournalIssue></Journal><ArticleTitle>Synthetic ${p}.</ArticleTitle>`
  + `<Abstract><AbstractText Label="RESULTS">${'r'.repeat(n)}</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`).join('')}</PubmedArticleSet>`;
const ncbiLectura = (status = 200, n) => async (url, init = {}) => {
  enviadas.push({ url: String(url), method: init.method, body: init.body?.toString() ?? '' });
  const ids = new URLSearchParams(init.body?.toString() ?? '').get('id')?.split(',') ?? [];
  return /efetch/.test(String(url)) ? new Response(status === 200 ? xmlLectura(ids, n) : '', { status })
    : { ok: true, status: 200, text: async () => JSON.stringify(respuestas['consulta-valida']) };
};
const leerCon = (handler, id, args) => handler({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'pubmed_fetch_exact', arguments: args } });
const CTX = { plan_ref: 'plan-1/r1', read_id: 'l1' };

const fp = FETCH_TOOL.inputSchema.properties;
check('M23', fp.pmids.maxItems === 5 && fp.pmids.minItems === 1 && fp.pmids.uniqueItems === true && fp.pmids.items.pattern === '^[1-9][0-9]{0,8}$'
  && FETCH_TOOL.inputSchema.additionalProperties === false && fp.context.additionalProperties === false
  && fp.context.required.join() === 'plan_ref,read_id' && FETCH_TOOL.inputSchema.required.join() === 'pmids,context'
  && !Object.keys(fp).some((k) => /offset|continu|retstart|url|format|db/.test(k))
  && FETCH_TOOL.annotations.readOnlyHint === true && /never cut|never/.test(FETCH_TOOL.description) && /not_found/.test(FETCH_TOOL.description)
  && /pubmed_fetch_exact/.test(ini.result.instructions),
  'pubmed_fetch_exact: 1-5 PMID en cadena sin ceros a la izquierda, contexto obligatorio, sin claves libres ni de continuación; las instrucciones la nombran');

enviadas.length = 0;
const hLectura = createMcpHandler({ fetcher: ncbiLectura(), run: { contract_version: 'x' } });
const malosLectura = [{ pmids: [], context: CTX }, { pmids: ['1', '2', '3', '4', '5', '6'], context: CTX }, { pmids: ['1', '1'], context: CTX },
  { pmids: [1], context: CTX }, { pmids: ['01'], context: CTX }, { pmids: null, context: CTX }, { pmids: ['1'] }, { pmids: ['1'], context: { plan_ref: 'p' } },
  { pmids: ['1'], context: CTX, text_offset: 100 }, { pmids: ['1'], context: CTX, expected_abstract_sha256: 'x' }, { pmids: ['1'], context: { ...CTX, extra: 1 } }];
const rechazosLectura = await Promise.all(malosLectura.map((args, i) => leerCon(hLectura, 300 + i, args)));
check('M24', rechazosLectura.every((r) => r.result.isError === true && r.result.structuredContent.rejected_before_ncbi === true
  && /^[0-9a-f-]{36}$/.test(r.result.structuredContent.attempt_id) && r.result.structuredContent.receipt_type === 'pubmed_fetch_exact')
  && enviadas.length === 0,
  `argumentos inválidos (vacío, seis, repetidos, número, cero a la izquierda, null, sin contexto, continuación, claves ajenas): rechazados con attempt_id y sin llamar a NCBI (${rechazosLectura.length})`);

enviadas.length = 0;
const RUN = { contract_version: 'x', repository_commit: 'y' };
const hMixto = createMcpHandler({ fetcher: ncbiLectura(), run: RUN, filters: paquete });
const lectura = (await leerCon(hMixto, 320, { pmids: ['11', '22', '33', '44', '55'], context: CTX })).result;
const busqueda = (await hMixto(llamada(321, `(asthma[tiab]) AND (${qT})`, { filters_used: ['filters/clinical/deprescription.txt'] }))).result;
const mensaje = { jsonrpc: '2.0', id: 320, result: lectura };
const fallida = (await leerCon(createMcpHandler({ fetcher: ncbiLectura(429), run: RUN }), 322, { pmids: ['11', '22'], context: CTX })).result;
const estructurado = Buffer.byteLength(JSON.stringify(lectura.structuredContent));
const rpc = Buffer.byteLength(JSON.stringify(mensaje));
check('M25', lectura.isError === false && lectura.content[0].text === JSON.stringify(lectura.structuredContent)
  && lectura.structuredContent.run === busqueda.structuredContent.run && lectura.structuredContent.engine === 'mcp'
  && lectura.structuredContent.status.delivery === 'complete' && lectura.structuredContent.results.length === 5
  && estructurado <= MAX_STRUCTURED_BYTES && rpc > 2 * estructurado && rpc < 2 * MAX_STRUCTURED_BYTES + 4096
  && busqueda.structuredContent.status.query_integrity === 'verified' && busqueda.structuredContent.status.filter_fidelity === 'verified'
  && !('record_identity' in busqueda.structuredContent.status) && !('query_integrity' in lectura.structuredContent.status)
  && fallida.isError === true && fallida.structuredContent.status.delivery === 'failed'
  && fallida.structuredContent.results.every((r) => r.record_status === 'error' && r.reason === 'http_status')
  && enviadas.filter((e) => /efetch/.test(e.url)).length === 2,
  `recibo en structuredContent y, idéntico y compacto, como texto: ${estructurado} B estructurados (≤ ${MAX_STRUCTURED_BYTES}) y ${rpc} B el mensaje JSON-RPC entero, que lo lleva dos veces; mismo run que la búsqueda, que conserva query_integrity y filter_fidelity; un 429 es error declarado`);

// Una sola cola para búsqueda y lectura: con la cola llena de búsquedas, la lectura también espera turno.
enviadas.length = 0;
const hCola = createMcpHandler({ fetcher: ncbiLectura(), maxQueueMs: 1000 });
const mezcla = await Promise.all([...Array.from({ length: 6 }, (_, i) => hCola(llamada(400 + i, 'x[tiab]'))),
  ...Array.from({ length: 6 }, (_, i) => leerCon(hCola, 410 + i, { pmids: [String(100 + i)], context: CTX }))]);
const lecturasOcupadas = mezcla.slice(6).filter((r) => r.result.structuredContent.failure?.code === 'service_busy');
check('M26', lecturasOcupadas.length > 0 && lecturasOcupadas.every((r) => r.result.isError === true
  && r.result.structuredContent.results.every((x) => x.record_status === 'error' && x.reason === 'service_busy'))
  && enviadas.length + lecturasOcupadas.length + mezcla.slice(0, 6).filter((r) => /SERVICIO_OCUPADO/.test(r.result.structuredContent.error ?? '')).length === 12,
  `búsqueda y lectura comparten la cola: tras seis búsquedas, ${lecturasOcupadas.length} de seis lecturas se rechazan como servicio ocupado, con error por PMID y nunca como ausencia`);

// --- Cribado por PMID con recibo (1.15.0, diseño 33-) ---------------------------------------------
const { SUMMARY_TOOL } = await import('./protocol.mjs');
const docsum = (p) => ({ uid: p, pubdate: '2021 Mar', source: 'Synth J', title: `Synthetic ${p}.`, pubtype: ['Journal Article'],
  articleids: [{ idtype: 'doi', value: `10.5555/${p}` }], attributes: ['Has Abstract'], doctype: 'citation', booktitle: '' });
const ncbiCriba = (status = 200) => async (url, init = {}) => {
  enviadas.push({ url: String(url), method: init.method, body: init.body?.toString() ?? '' });
  const ids = new URLSearchParams(init.body?.toString() ?? '').get('id')?.split(',') ?? [];
  if (/esummary/.test(String(url))) {
    return new Response(status === 200 ? JSON.stringify({ header: { type: 'esummary', version: '0.3' },
      result: { uids: ids, ...Object.fromEntries(ids.map((p) => [p, docsum(p)])) } }) : '', { status });
  }
  return ncbiLectura()(url, init);
};
const cribarCon = (handler, id, args) => handler({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'pubmed_summary_exact', arguments: args } });
const SCTX = { plan_ref: 'plan-1/r1', screen_id: 's1' };

const sp = SUMMARY_TOOL.inputSchema.properties;
const descBusqueda = listaFuente.find((t) => t.name === 'pubmed_search_exact').description;
enviadas.length = 0;
const hCriba = createMcpHandler({ fetcher: ncbiCriba(), run: { contract_version: 'x' } });
const malosCriba = [{ pmids: [], context: SCTX }, { pmids: Array.from({ length: 51 }, (_, i) => String(i + 1)), context: SCTX },
  { pmids: ['1', '1'], context: SCTX }, { pmids: [1], context: SCTX }, { pmids: ['01'], context: SCTX }, { pmids: ['1'] },
  { pmids: ['1'], context: CTX }, { pmids: ['1'], context: SCTX, include_abstract: true }, { pmids: ['1'], context: { ...SCTX, extra: 1 } }];
const rechazosCriba = await Promise.all(malosCriba.map((args, i) => cribarCon(hCriba, 600 + i, args)));
check('M28', sp.pmids.maxItems === 50 && sp.pmids.minItems === 1 && sp.pmids.uniqueItems === true && sp.pmids.items.pattern === '^[1-9][0-9]{0,8}$'
  && SUMMARY_TOOL.inputSchema.additionalProperties === false && sp.context.additionalProperties === false
  && sp.context.required.join() === 'plan_ref,screen_id' && SUMMARY_TOOL.inputSchema.required.join() === 'pmids,context'
  && !Object.keys(sp).some((k) => /abstract|offset|continu|retstart|url|format|db/.test(k)) && SUMMARY_TOOL.annotations.readOnlyHint === true
  && /never the abstract/.test(SUMMARY_TOOL.description) && /never turns a record into a finding/.test(SUMMARY_TOOL.description)
  && /pubmed_fetch_exact/.test(SUMMARY_TOOL.description) && /titles_screened/.test(SUMMARY_TOOL.description)
  && /pubmed_summary_exact/.test(descBusqueda) && /pubmed_summary_exact/.test(ini.result.instructions)
  && rechazosCriba.every((r) => r.result.isError === true && r.result.structuredContent.rejected_before_ncbi === true
    && /^[0-9a-f-]{36}$/.test(r.result.structuredContent.attempt_id) && r.result.structuredContent.receipt_type === 'pubmed_summary_exact')
  && enviadas.length === 0,
  `pubmed_summary_exact: 1-50 PMID en cadena, contexto con screen_id, sin abstract ni claves libres; la búsqueda y las instrucciones la nombran; ${
    rechazosCriba.length} argumentos inválidos rechazados con attempt_id y sin llamar a NCBI`);

enviadas.length = 0;
const hCribaMixto = createMcpHandler({ fetcher: ncbiCriba(), run: RUN, filters: paquete });
const criba = (await cribarCon(hCribaMixto, 620, { pmids: Array.from({ length: 50 }, (_, i) => String(1000 + i)), context: SCTX })).result;
const busquedaCriba = (await hCribaMixto(llamada(621, 'asthma[tiab]'))).result;
const cribaFallida = (await cribarCon(createMcpHandler({ fetcher: ncbiCriba(503), run: RUN }), 622, { pmids: ['11', '22'], context: SCTX })).result;
const hColaCriba = createMcpHandler({ fetcher: ncbiCriba(), maxQueueMs: 1000 });
const mezclaCriba = await Promise.all([...Array.from({ length: 6 }, (_, i) => hColaCriba(llamada(630 + i, 'x[tiab]'))),
  ...Array.from({ length: 6 }, (_, i) => cribarCon(hColaCriba, 640 + i, { pmids: [String(100 + i)], context: SCTX }))]);
const cribasOcupadas = mezclaCriba.slice(6).filter((r) => r.result.structuredContent.failure?.code === 'service_busy');
check('M29', criba.isError === false && criba.content[0].text === JSON.stringify(criba.structuredContent)
  && criba.structuredContent.run === busquedaCriba.structuredContent.run && criba.structuredContent.engine === 'mcp'
  && criba.structuredContent.status.delivery === 'complete' && criba.structuredContent.results.length === 50
  && criba.structuredContent.counts_as === 'titles_screened' && Buffer.byteLength(JSON.stringify(criba.structuredContent)) <= MAX_STRUCTURED_BYTES
  && cribaFallida.isError === true && cribaFallida.structuredContent.status.delivery === 'failed'
  && cribaFallida.structuredContent.results.every((r) => r.record_status === 'error' && r.reason === 'http_status')
  && cribasOcupadas.length > 0 && cribasOcupadas.every((r) => r.result.isError === true
    && r.result.structuredContent.results.every((x) => x.record_status === 'error' && x.reason === 'service_busy')),
  `cribado de 50 en una llamada (${Buffer.byteLength(JSON.stringify(criba.structuredContent))} B), compacto e idéntico en texto, con el run de la búsqueda; un 503 es error declarado;`
  + ` comparte la cola con la búsqueda: ${cribasOcupadas.length} de seis cribados, servicio ocupado`);

// M30 (revisión de Codex del lote 1.15, R3). Un rechazo previo a NCBI también cabe en 24 KiB, con un motivo
// útil y su identidad mínima: clave larga, en los argumentos o en el contexto, multibyte y muchas claves.
enviadas.length = 0;
const largos = [{ pmids: ['1'], context: SCTX, ['a'.repeat(30000)]: 1 }, { pmids: ['1'], context: { ...SCTX, ['b'.repeat(30000)]: 1 } },
  { pmids: ['1'], context: SCTX, ['€'.repeat(20000)]: 1 }, { pmids: ['1'], context: SCTX, ...Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}_${'x'.repeat(40)}`, 1])) }];
const rechazosLargos = await Promise.all(largos.map((args, i) => cribarCon(hCriba, 700 + i, args)));
const normal30 = (await cribarCon(hCriba, 710, { pmids: ['1'], context: SCTX, include_abstract: true })).result.structuredContent;
check('M30', rechazosLargos.every(({ result: r }) => r.isError === true && r.structuredContent.rejected_before_ncbi === true
    && Buffer.byteLength(JSON.stringify(r.structuredContent)) <= MAX_STRUCTURED_BYTES && r.content[0].text === JSON.stringify(r.structuredContent)
    && /no admitid[ao]s/.test(r.structuredContent.error) && r.structuredContent.receipt_type === 'pubmed_summary_exact'
    && /^[0-9a-f-]{36}$/.test(r.structuredContent.attempt_id) && typeof r.structuredContent.received_at === 'string' && r.structuredContent.run?.contract_version === 'x')
  && /y 1995 más/.test(rechazosLargos[3].result.structuredContent.error)
  && normal30.error === 'argumentos no admitidos: include_abstract' && enviadas.length === 0,
  `rechazos con claves de 30.000 letras (argumentos y contexto), 20.000 «€» y 2.000 claves: ${rechazosLargos.map(({ result: r }) =>
    Buffer.byteLength(JSON.stringify(r.structuredContent))).join(', ')} B, todos ≤ ${MAX_STRUCTURED_BYTES}, con motivo, run, intento y hora, sin NCBI; el normal sigue nombrando la clave`);

// --- Canal de llegada a la superficie (1.14.1, plan 32- U2) ----------------------------------------
// Medido el 2026-10-26 sobre d610902: a una superficie sin terminal solo le llega del router lo que sirve
// `guidance` (6,6 de 87 KB) y lo que dicen las descripciones de las herramientas, y las cuatro reglas de
// la 1.14.1 estaban escritas donde no se sirve. Aquí cada regla de retrieval_policy declara su canal en
// mcp/surface-channels.json y la declaración se comprueba contra lo que se anuncia de verdad. No prueba
// que la superficie lea la regla ni que la cumpla.

const { GUIDANCE_PATHS, routerValue } = await import('../scripts/filter-source.mjs');
const ROUTER = JSON.parse(readFileSync(join(RAIZ_REPO, 'neurosymbolic_router.json'), 'utf8'));
const CANALES = JSON.parse(readFileSync(join(HERE, 'surface-channels.json'), 'utf8'));
const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** El texto que anuncia una herramienta: su descripción, o la de un parámetro por ruta con puntos. */
function textoAnunciado(tools, tool, field) {
  const t = Array.isArray(tools) ? tools.find((x) => x?.name === tool) : undefined;
  if (!t || typeof field !== 'string') return null;
  if (field === 'description') return typeof t.description === 'string' ? t.description : null;
  let nodo = { properties: t.inputSchema?.properties };
  for (const k of field.split('.')) nodo = esObjeto(nodo?.properties) && Object.hasOwn(nodo.properties, k) ? nodo.properties[k] : undefined;
  return typeof nodo?.description === 'string' ? nodo.description : null;
}

/** Problemas del inventario de canales frente al router, a `guidance` servida y a tools/list. */
function problemasDeCanal(router, guidance, rutas, tools, canales) {
  const problemas = [];
  const politica = router?.rule_classification?.retrieval_policy;
  if (!Array.isArray(politica) || !esObjeto(canales) || !esObjeto(canales.reglas) || !esObjeto(guidance) || !esObjeto(rutas)) {
    return ['el router, el inventario, guidance o la tabla de rutas no tienen la forma esperada'];
  }
  // Primero lo global: toda ruta de guidance existe y sale literal, y no se sirve nada sin ruta.
  for (const [clave, ruta] of Object.entries(rutas)) {
    const valor = typeof ruta === 'string' ? routerValue(router, ruta) : undefined;
    if (valor === undefined || valor === null) problemas.push(`guidance.${clave} sale vacía: ${ruta} no existe en el router`);
    else if (JSON.stringify(guidance[clave]) !== JSON.stringify(valor)) problemas.push(`guidance.${clave} no es literal a ${ruta}`);
  }
  for (const clave of Object.keys(guidance)) if (!Object.hasOwn(rutas, clave)) problemas.push(`guidance.${clave} se sirve sin ruta declarada`);
  const universo = politica.flatMap((s) => (esObjeto(router[s]) ? Object.keys(router[s]).map((k) => `${s}.${k}`) : [s]));
  const reglas = canales.reglas;
  for (const r of universo) if (!Object.hasOwn(reglas, r)) problemas.push(`${r}: regla sin canal declarado`);
  for (const r of Object.keys(reglas)) if (!universo.includes(r)) problemas.push(`${r}: declarada y no existe en el router`);
  const dentro = (ruta, regla) => typeof ruta === 'string' && (ruta === regla || ruta.startsWith(`${regla}.`));
  for (const [regla, canal] of Object.entries(reglas)) {
    if (canal === 'not_served') continue;
    if (!esObjeto(canal) || Object.keys(canal).length === 0 || Object.keys(canal).some((k) => !['guidance', 'tool_text'].includes(k))) {
      problemas.push(`${regla}: canal no reconocido`);
      continue;
    }
    if (Object.hasOwn(canal, 'guidance') && !(typeof canal.guidance === 'string' && dentro(rutas[canal.guidance], regla))) {
      problemas.push(`${regla}: guidance.${canal.guidance} no sirve esta regla`);
    }
    if (Object.hasOwn(canal, 'tool_text')) {
      const textos = Array.isArray(canal.tool_text) && canal.tool_text.length ? canal.tool_text : [null];
      for (const x of textos) {
        const texto = esObjeto(x) ? textoAnunciado(tools, x.tool, x.field) : null;
        if (!(typeof x?.fragment === 'string' && x.fragment.length >= 12 && typeof texto === 'string' && texto.includes(x.fragment))) {
          problemas.push(`${regla}: el fragmento no está en ${x?.tool ?? '?'}.${x?.field ?? '?'}`);
        }
      }
    }
  }
  // Y al revés: lo que guidance sirve de retrieval_policy está declarado por la regla que lo contiene.
  for (const [clave, ruta] of Object.entries(rutas)) {
    if (typeof ruta !== 'string' || !politica.includes(ruta.split('.')[0])) continue;
    if (!Object.entries(reglas).some(([regla, canal]) => esObjeto(canal) && canal.guidance === clave && dentro(ruta, regla))) {
      problemas.push(`guidance.${clave} se sirve y ninguna regla lo declara`);
    }
  }
  return problemas;
}

const herramientasAnunciadas = listaFuente;
const canalReal = problemasDeCanal(ROUTER, cat.guidance, GUIDANCE_PATHS, herramientasAnunciadas, CANALES);
const valores = Object.values(CANALES.reglas);
const cuantas = { guidance: valores.filter((v) => esObjeto(v) && v.guidance).length,
  tool_text: valores.filter((v) => esObjeto(v) && v.tool_text).length, not_served: valores.filter((v) => v === 'not_served').length };
// Controles negativos: cada forma de perder el canal en silencio tiene que aparecer como problema, sin lanzar.
const clon = (o) => JSON.parse(JSON.stringify(o));
const sinRegla = clon(CANALES); delete sinRegla.reglas['saturation_policy.recency_before_closing'];
const routerNuevo = clon(ROUTER); routerNuevo.saturation_policy.regla_nueva = 'A new rule for the surface.';
const rutaRota = { ...GUIDANCE_PATHS, recency_before_closing: 'saturation_policy.recency_before_close' };
const guiaVaciada = { ...cat.guidance, order_hides_by_age: null };
const sinFrase = clon(herramientasAnunciadas);
sinFrase.find((x) => x.name === 'pubmed_search_exact').inputSchema.properties.sort.description = 'Omit for the default order.';
const canalMalo = clon(CANALES); canalMalo.reglas['provenance.denominators'] = 'guidance';
const textoMalo = clon(CANALES); textoMalo.reglas['provenance.denominators'] = { tool_text: 'records_retrieved' };
const guiaSinDeclarar = clon(CANALES); guiaSinDeclarar.reglas['saturation_policy.recency_before_closing'] = 'not_served';
const controles = [
  ['regla sin canal', problemasDeCanal(ROUTER, cat.guidance, GUIDANCE_PATHS, herramientasAnunciadas, sinRegla), /recency_before_closing: regla sin canal/],
  ['regla nueva en el router', problemasDeCanal(routerNuevo, cat.guidance, GUIDANCE_PATHS, herramientasAnunciadas, CANALES), /regla_nueva: regla sin canal/],
  ['ruta rota', problemasDeCanal(ROUTER, cat.guidance, rutaRota, herramientasAnunciadas, CANALES), /recency_before_closing sale vacía/],
  ['guidance vaciada', problemasDeCanal(ROUTER, guiaVaciada, GUIDANCE_PATHS, herramientasAnunciadas, CANALES), /order_hides_by_age no es literal/],
  ['frase quitada', problemasDeCanal(ROUTER, cat.guidance, GUIDANCE_PATHS, sinFrase, CANALES), /order_hides_by_age: el fragmento no está en pubmed_search_exact\.sort/],
  ['canal mal escrito', problemasDeCanal(ROUTER, cat.guidance, GUIDANCE_PATHS, herramientasAnunciadas, canalMalo), /denominators: canal no reconocido/],
  ['tool_text sin lista', problemasDeCanal(ROUTER, cat.guidance, GUIDANCE_PATHS, herramientasAnunciadas, textoMalo), /denominators: el fragmento no está/],
  ['guidance sin declarar', problemasDeCanal(ROUTER, cat.guidance, GUIDANCE_PATHS, herramientasAnunciadas, guiaSinDeclarar), /recency_before_closing se sirve y ninguna regla/],
  ['inventario que no es objeto', problemasDeCanal(ROUTER, cat.guidance, GUIDANCE_PATHS, herramientasAnunciadas, []), /forma esperada/],
].filter(([, p, patron]) => !p.some((x) => patron.test(x))).map(([nombre]) => nombre);
check('M27', canalReal.length === 0 && controles.length === 0 && cuantas.guidance >= 4
  && ['order_hides_by_age', 'pagination_order_recommendation', 'condition_guideline_pass', 'recency_before_closing']
    .every((k) => typeof cat.guidance[k] === 'string' || esObjeto(cat.guidance[k])),
  canalReal.length === 0 && controles.length === 0
    ? `cada regla de retrieval_policy declara su canal (${valores.length}: ${cuantas.guidance} en guidance, ${cuantas.tool_text} en descripciones, ${cuantas.not_served} sin servir) y la declaración se cumple; el orden, las guías y la recencia de la 1.14.1 salen en el catálogo`
    : `canal: ${[...canalReal, ...controles.map((c) => `control sin detectar: ${c}`)].join('; ')}`);

// --- Transporte HTTP del Worker ------------------------------------------------------------------

const realFetch = globalThis.fetch;
globalThis.fetch = sirve(JSON.stringify(respuestas['consulta-valida']));
const K1 = 'a'.repeat(32);
const K2 = 'b'.repeat(40);
const env = { ACCESS_KEY: `${K1}, ${K2}` };
const pedir = (path, init = {}) => worker.fetch(new Request(`https://w.example${path}`, init), env);
const post = (path, body) => pedir(path, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body) });
try {
  const rutas = await Promise.all([pedir('/'), post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }),
    post('/mcp/otra', { jsonrpc: '2.0', id: 1, method: 'ping' }), pedir(`/mcp/${K1}`)]);
  check('W1', rutas.map((r) => r.status).join() === '404,404,404,405',
    'sin la clave de acceso todo es 404; GET en el endpoint es 405 (sin flujo SSE)');

  const ok = await post(`/mcp/${K1}`, llamada(1, '"Atherosclerosis"[Mesh]'));
  const okBody = await ok.json();
  const notif = await post(`/mcp/${K1}`, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const lote = await post(`/mcp/${K1}`, [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'x' }]);
  const roto = await post(`/mcp/${K1}`, '{no es json');
  const enorme = await post(`/mcp/${K1}`, JSON.stringify(llamada(1, 'x'.repeat(70000))));
  const opciones = await pedir(`/mcp/${K1}`, { method: 'OPTIONS' });
  check('W2', ok.status === 200 && ok.headers.get('content-type') === 'application/json'
    && okBody.result.structuredContent.engine === 'mcp/worker.mjs'
    && notif.status === 202 && lote.status === 400
    && roto.status === 400 && enorme.status === 413 && opciones.status === 204,
    'POST devuelve JSON; notificación 202; lote rechazado 400 (2025-06-18); JSON roto 400; cuerpo enorme 413; OPTIONS 204');

  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const conEnv = (e, path = `/mcp/${K1}`) => worker.fetch(new Request(`https://w.example${path}`, { method: 'POST', body: ping }), e);
  const sinClave = await conEnv({}, '/mcp');
  const debil = await conEnv({ ACCESS_KEY: `${K1},corta` });
  // La frontera exacta: 31 caracteres no, 32 sí (una mutación que bajaba el mínimo a 8 sobrevivía).
  const de31 = await conEnv({ ACCESS_KEY: 'c'.repeat(31) }, `/mcp/${'c'.repeat(31)}`);
  const segunda = await conEnv(env, `/mcp/${K2}`);
  const retirada = await conEnv({ ACCESS_KEY: K2 });
  check('W3', sinClave.status === 503 && debil.status === 503 && de31.status === 503 && segunda.status === 200
    && retirada.status === 404 && K1.length === 32,
    'sin clave, o con una de menos de 32 caracteres, no atiende (503); varias claves valen y quitar una corta solo esa');

  // Origin: sin él (cliente de servidor a servidor) se atiende; uno no admitido, 403; uno admitido, con CORS propio.
  const conOrigen = (origin, e = env) => worker.fetch(new Request(`https://w.example/mcp/${K1}`,
    { method: 'POST', headers: { origin }, body: ping }), e);
  const ajeno = await conOrigen('https://untrusted.example');
  const admitido = await conOrigen('https://claude.ai', { ...env, ALLOWED_ORIGINS: 'https://claude.ai' });
  check('W4', ajeno.status === 403 && admitido.status === 200
    && admitido.headers.get('access-control-allow-origin') === 'https://claude.ai'
    && ok.headers.get('access-control-allow-origin') === null,
    'Origin ajeno 403; admitido solo si se declara, con CORS para ese origen y nunca «*»');

  const conVersion = (v) => worker.fetch(new Request(`https://w.example/mcp/${K1}`,
    { method: 'POST', headers: { 'mcp-protocol-version': v }, body: ping }), env);
  const vMala = await conVersion('1999-01-01');
  const vBuena = await conVersion('2025-06-18');
  check('W5', vMala.status === 400 && vBuena.status === 200,
    'MCP-Protocol-Version no soportada 400; la soportada se atiende');

  // El saludo negocia: con cabecera y versión posteriores, `initialize` responde con la nuestra.
  const saludo = await worker.fetch(new Request(`https://w.example/mcp/${K1}`, { method: 'POST',
    headers: { 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) }), env);
  const saludoBody = saludo.status === 200 ? await saludo.json() : null;
  const despues = await conVersion('2025-11-25');
  check('W7', saludo.status === 200 && saludoBody?.result?.protocolVersion === '2025-06-18' && despues.status === 400,
    'initialize con una versión posterior negocia la soportada (200); después, esa cabecera sigue siendo 400');

  // El límite es de BYTES: 40.000 «é» son 40.053 caracteres y 80.053 bytes (el caso de Codex).
  const enBytes = await post(`/mcp/${K1}`, JSON.stringify(llamada(1, 'é'.repeat(40000))));
  const declarado = await worker.fetch(new Request(`https://w.example/mcp/${K1}`, { method: 'POST',
    headers: { 'content-length': String(10 * 1024 * 1024) }, body: ping }), env);
  check('W6', enBytes.status === 413 && declarado.status === 413,
    'el límite de 64 KiB cuenta bytes, no caracteres, y un Content-Length mayor se rechaza sin leer');

  // El Worker sirve el MISMO paquete que se sella: catálogo y filtros sin disco en Cloudflare.
  const wLista = await (await post(`/mcp/${K1}`, { jsonrpc: '2.0', id: 50, method: 'tools/list' })).json();
  const wFiltro = await (await post(`/mcp/${K1}`, { jsonrpc: '2.0', id: 51, method: 'tools/call',
    params: { name: 'pubmed_get_filter', arguments: { path: 'filters/scope/spanish.txt' } } })).json();
  check('W8', wLista.result.tools.length === 5
    && wFiltro.result.structuredContent.query === paquete.filters['filters/scope/spanish.txt'].query
    && wFiltro.result.structuredContent.catalog_sha256 === paquete.catalog_sha256,
    'el Worker anuncia las cinco herramientas y sirve la consulta canónica sellada, idéntica a la del repositorio');

  // La lectura por el Worker: el sello del despliegue, su motor y su tiempo máximo, con la cola compartida.
  globalThis.fetch = ncbiLectura();
  const wLectura = await (await post(`/mcp/${K1}`, { jsonrpc: '2.0', id: 52, method: 'tools/call',
    params: { name: 'pubmed_fetch_exact', arguments: { pmids: ['11'], context: CTX } } })).json();
  const wl = wLectura.result?.structuredContent;
  const { default: sello } = await import('./build-info.mjs');
  check('W9', wl?.engine === 'mcp/worker.mjs' && wl.limits.timeout_ms === 25000 && wl.run?.repository_commit === sello.repository_commit
    && ['scripts/fetch-core.mjs', 'scripts/efetch.mjs', 'scripts/xml-lite.mjs', 'scripts/abstract-canonical.mjs'].every((f) => typeof sello.code_sha256[f] === 'string')
    && wl.status.delivery === 'complete' && wLectura.result.content[0].text === JSON.stringify(wl),
    'el Worker lee por PMID con su sello, su motor y su tiempo máximo, y el sello cubre los ficheros de la lectura');

  // El cribado por el Worker: el mismo sello y su motor, y el sello cubre los dos ficheros nuevos (1.15.0).
  globalThis.fetch = ncbiCriba();
  const wCriba = await (await post(`/mcp/${K1}`, { jsonrpc: '2.0', id: 53, method: 'tools/call',
    params: { name: 'pubmed_summary_exact', arguments: { pmids: ['11', '22'], context: SCTX } } })).json();
  const wc = wCriba.result?.structuredContent;
  check('W10', wc?.engine === 'mcp/worker.mjs' && wc.limits.timeout_ms === 25000 && wc.run?.repository_commit === sello.repository_commit
    && ['scripts/summary-core.mjs', 'scripts/esummary.mjs'].every((f) => typeof sello.code_sha256[f] === 'string')
    && wc.status.delivery === 'complete' && wCriba.result.content[0].text === JSON.stringify(wc),
    'el Worker criba por PMID con su sello, su motor y su tiempo máximo, y el sello cubre los ficheros del cribado');
} finally {
  globalThis.fetch = realFetch;
}

for (const l of pass) console.log(`  pass  ${l}`);
for (const l of fail) console.log(`  FAIL  ${l}`);
console.log(`\n${pass.length} pass / ${fail.length} fail`);
process.exit(fail.length === 0 ? 0 : 1);
