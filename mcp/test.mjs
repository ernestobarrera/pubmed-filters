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
check('M12', listaFuente.map((t) => t.name).join() === 'pubmed_search_exact,pubmed_filter_catalog,pubmed_get_filter'
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
  check('W8', wLista.result.tools.length === 3
    && wFiltro.result.structuredContent.query === paquete.filters['filters/scope/spanish.txt'].query
    && wFiltro.result.structuredContent.catalog_sha256 === paquete.catalog_sha256,
    'el Worker anuncia las tres herramientas y sirve la consulta canónica sellada, idéntica a la del repositorio');
} finally {
  globalThis.fetch = realFetch;
}

for (const l of pass) console.log(`  pass  ${l}`);
for (const l of fail) console.log(`  FAIL  ${l}`);
console.log(`\n${pass.length} pass / ${fail.length} fail`);
process.exit(fail.length === 0 ? 0 : 1);
