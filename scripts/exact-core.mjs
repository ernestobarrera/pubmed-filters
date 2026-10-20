/**
 * Núcleo del ejecutor de referencia: una consulta PubMed literal y su recibo.
 *
 * Es código PURO: solo `fetch`, `URLSearchParams` y Web Crypto, sin `node:fs`, `node:child_process` ni
 * nada que dependa de una máquina concreta. Por eso lo comparten el CLI (`pubmed-exact.mjs`), el MCP
 * local (`mcp/stdio.mjs`) y el MCP en Cloudflare Workers (`mcp/worker.mjs`): tres superficies, un solo
 * juicio. Si una de ellas necesitara su propio ejecutor, el recibo dejaría de significar lo mismo.
 */

import { inspectResponse } from './parse-filter.mjs';
import { esearch, ESEARCH_URL } from './esearch.mjs';

/** SHA-256 en hexadecimal con Web Crypto, que existe igual en Node 18+ y en Workers. */
export async function sha256(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Ventana de ESearch para PubMed: 9.999 registros, retstart <= 9998. Lo dice PubMed en su propio ERROR,
 * medido el 2026-10-08 contra E-utilities: «'retstart' cannot be larger than 9998. For PubMed, ESearch
 * can only retrieve the first 9,999 records matching the query». Con retmax=10000 no falla: recorta a
 * 9.999 y avisa en outputmessages («Restrictions achieved…»).
 *
 * Historia, porque la cifra ya se discutió: la primera versión fijó 9.999 por lo observado en un
 * conector; una revisión externa objetó que NCBI documenta 10.000 y se cambió; la medición directa
 * dio la razón al comportamiento, no a la documentación. Lo que no depende de la cifra: un rechazo de
 * NCBI nunca es un recuento de cero, y recuperar menos de lo que hay se declara (`records_complete`).
 */
export const ESEARCH_WINDOW = 9999;

/**
 * Integridad de la consulta, en el vocabulario de provenance.operational_status:
 *   verified     PubMed devolvió su diagnóstico y no hay nada descartado, roto ni dudoso.
 *   failed       PubMed devolvió su diagnóstico y muestra que la consulta NO se ejecutó como se
 *                escribió (término descartado, error, recuento inservible, o una etiqueta de
 *                campo que no existe y que PubMed descarta sin avisar).
 *   unsupported  No se puede saber: falta querytranslation, así que el diagnóstico no es verificable.
 */
export function queryIntegrity(inspection) {
  // Primero lo conocido: una anomalía refuta la integridad aunque falte el diagnóstico completo.
  // La primera versión preguntaba antes por `verifiable` y un ERROR sin querytranslation salía
  // `unsupported`, escondiendo un defecto conocido detrás de un desconocido (Codex, 2026-10-08).
  if (inspection.anomalies.length > 0) return 'failed';
  return inspection.usable ? 'verified' : 'unsupported';
}

/** Órdenes admitidos (1.13.0). Solo relevancia: omitido, ESearch usa el suyo («Most Recent»). */
export const SORT_VALUES = ['relevance'];

/** «Restrictions achieved. start and count adjusted to S, C»: la posición y el tamaño que NCBI sirvió. */
const ADJUSTED = /adjusted to ([0-9]+), ([0-9]+)/i;

/**
 * ¿Dice NCBI haber servido otra posición u otro tamaño que los enviados? La usan el ejecutor (para no
 * ofrecer continuación) y el comprobador de unión (para no aceptar la página): un solo juicio, y la unión
 * lo hace sobre el aviso mismo, no sobre lo que el ejecutor concluyó de él (Codex, R1, 2026-10-20).
 */
export function pageAdjusted(notices, retstart, retmaxSent) {
  return (notices ?? []).map((m) => ADJUSTED.exec(m)).filter(Boolean)
    .some(([, s, c]) => Number(s) !== retstart || Number(c) !== retmaxSent);
}

/**
 * Continuación de una página (1.13.0, especificación 18- y adenda de Codex). Las reglas van en este
 * orden y la primera que se cumple decide. `page_adjusted` es la única que la tabla de la adenda no
 * nombra: NCBI dice haber servido otra posición u otro tamaño que los enviados (o devuelve más PMIDs de
 * los pedidos), y una continuación calculada sobre la posición pedida sería una posición inferida.
 * Que no haya continuación nunca significa que se haya recuperado todo.
 */
export function continuation({ integrity, retstart, retmaxRequested, retmaxSent, count, n, notices }) {
  const stop = (reason) => ({ next_retstart: null, next_retstart_reason: reason });
  if (integrity !== 'verified' || count === null) return stop('not_verified');
  if (retmaxRequested === 0) return stop('count_only');
  if (pageAdjusted(notices, retstart, retmaxSent) || n > retmaxSent) return stop('page_adjusted');
  if (n === 0 && count > retstart) return stop('empty_page');
  if (retstart + n >= count) return stop('end_of_set');
  if (retstart + n > ESEARCH_WINDOW - 1) return stop('window_limit');
  return { next_retstart: retstart + n, next_retstart_reason: null };
}

/** Ejecuta `term` tal cual y devuelve el recibo. Un 413/414 lanza TransportError: nunca hay recibo con recuento. */
/**
 * `email` es el contacto que NCBI pide junto a `tool` para poder avisar antes de bloquear: viaja a NCBI
 * y nunca al recibo, igual que la clave. `timeoutMs` corta una petición colgada: sin él, un Worker o un
 * chat esperan sin fin, y lo que llega después es un error declarado, nunca un recuento.
 *
 * Paginación (1.13.0): `retstart` (omitido = 0) pide otra página y `sort: 'relevance'` otro orden. Cada
 * página es una llamada independiente: el servidor no guarda nada y no promete que el conjunto sea el
 * mismo entre páginas. Una petición que cruza la ventana se acota ANTES de enviarla (`retmax_sent`), en
 * vez de depender del recorte y del aviso de NCBI. `sort` omitido no se envía: nunca un orden por defecto.
 */
export async function runExact(term, {
  retmax = 0, retstart = 0, sort, apiKey = '', email = '', tool = 'pubmed-filters-exact',
  engine = 'scripts/pubmed-exact.mjs', timeoutMs = 30000, fetcher, now = () => new Date(),
} = {}) {
  if (typeof term !== 'string' || term.trim() === '') throw new Error('La consulta está vacía.');
  if (!Number.isSafeInteger(retmax) || retmax < 0 || retmax > ESEARCH_WINDOW) {
    throw new Error(`retmax debe ser un entero entre 0 y ${ESEARCH_WINDOW}.`);
  }
  if (!Number.isSafeInteger(retstart) || retstart < 0 || retstart > ESEARCH_WINDOW - 1) {
    throw new Error(`retstart debe ser un entero entre 0 y ${ESEARCH_WINDOW - 1}.`);
  }
  if (sort !== undefined && !SORT_VALUES.includes(sort)) {
    throw new Error(`sort solo admite ${SORT_VALUES.map((s) => `"${s}"`).join(', ')}; omitido, PubMed usa su orden.`);
  }
  // Validado lo pedido, se acota lo enviado: el acotado nunca convierte en válido un valor que no lo era.
  const retmaxSent = Math.min(retmax, ESEARCH_WINDOW - retstart);
  const params = {
    retmax: String(retmaxSent), ...(retstart > 0 ? { retstart: String(retstart) } : {}), ...(sort ? { sort } : {}),
    tool, ...(email ? { email } : {}), ...(apiKey ? { api_key: apiKey } : {}),
  };
  const executedAt = now().toISOString();
  const { transport, esearchresult, raw } = await esearch(term, {
    params, signal: AbortSignal.timeout(timeoutMs), ...(fetcher ? { fetcher } : {}),
  });

  const r = esearchresult ?? {};
  const inspection = inspectResponse(esearchresult, { sentQuery: term });
  const count = inspection.countIsValid ? Number(r.count) : null;
  const pmids = Array.isArray(r.idlist) ? r.idlist.map(String) : [];
  const integrity = queryIntegrity(inspection);
  const n = pmids.length;

  return {
    executed_at: executedAt,
    engine,
    endpoint: ESEARCH_URL,
    sent_query: term,
    sent_query_sha256: await sha256(term),
    transport,
    // `retmax` se conserva como alias de `retmax_requested`: un consumidor de la 1.12 lee lo mismo que leía.
    request: {
      retstart, retmax, retmax_requested: retmax, retmax_sent: retmaxSent, sort: sort ?? null,
      api_key_used: Boolean(apiKey), email_used: Boolean(email),
    },
    result_count: count,
    count_raw: r.count ?? null,
    records_retrieved: n,
    // Por llamada: ESTA respuesta trae todo el conjunto. La última página de un recorrido no lo es.
    records_complete: retstart === 0 && count !== null && n === count,
    // El tramo de la posición PEDIDA; no prueba por sí solo que NCBI sirviera ese offset.
    page: n > 0 ? { first: retstart + 1, last: retstart + n } : null,
    ...continuation({ integrity, retstart, retmaxRequested: retmax, retmaxSent, count, n, notices: inspection.pagination }),
    window_limit: count !== null && count > ESEARCH_WINDOW
      ? `De ${count} registros, ESearch solo sirve los primeros ${ESEARCH_WINDOW}: el resto no es `
        + `accesible por esta vía (EFetch con historial, o particionar por fechas).`
      : null,
    pmids,
    pmid_list_sha256: await sha256(pmids.join('\n')),
    querytranslation: r.querytranslation ?? null,
    warninglist: r.warninglist ?? null,
    errorlist: r.errorlist ?? null,
    fatal_error: r.ERROR ?? null,
    raw_response_sha256: await sha256(raw),
    pagination_notices: inspection.pagination,
    status: { query_integrity: integrity },
    problems: inspection.problems,
  };
}

