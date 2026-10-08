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
  if (!inspection.verifiable) return 'unsupported';
  return inspection.usable ? 'verified' : 'failed';
}

/** Ejecuta `term` tal cual y devuelve el recibo. Un 413/414 lanza TransportError: nunca hay recibo con recuento. */
export async function runExact(term, { retmax = 0, apiKey = '', tool = 'pubmed-filters-exact', engine = 'scripts/pubmed-exact.mjs', fetcher, now = () => new Date() } = {}) {
  if (typeof term !== 'string' || term.trim() === '') throw new Error('La consulta está vacía.');
  if (!Number.isSafeInteger(retmax) || retmax < 0 || retmax > ESEARCH_WINDOW) {
    throw new Error(`retmax debe ser un entero entre 0 y ${ESEARCH_WINDOW}.`);
  }
  const params = { retmax: String(retmax), tool, ...(apiKey ? { api_key: apiKey } : {}) };
  const executedAt = now().toISOString();
  const { transport, esearchresult, raw } = await esearch(term, { params, ...(fetcher ? { fetcher } : {}) });

  const r = esearchresult ?? {};
  const inspection = inspectResponse(esearchresult, { sentQuery: term });
  const count = inspection.countIsValid ? Number(r.count) : null;
  const pmids = Array.isArray(r.idlist) ? r.idlist.map(String) : [];

  return {
    executed_at: executedAt,
    engine,
    endpoint: ESEARCH_URL,
    sent_query: term,
    sent_query_sha256: await sha256(term),
    transport,
    request: { retstart: 0, retmax, api_key_used: Boolean(apiKey) },
    result_count: count,
    count_raw: r.count ?? null,
    records_retrieved: pmids.length,
    records_complete: count !== null && pmids.length === count,
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
    status: { query_integrity: queryIntegrity(inspection) },
    problems: inspection.problems,
  };
}

