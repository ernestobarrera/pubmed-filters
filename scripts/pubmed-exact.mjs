#!/usr/bin/env node
/**
 * Ejecutor de referencia: una consulta PubMed literal y su recibo.
 *
 *   node scripts/pubmed-exact.mjs '<consulta>'                 solo recuento y diagnóstico (retmax=0)
 *   node scripts/pubmed-exact.mjs '<consulta>' --retmax 200    además, los primeros 200 PMIDs
 *   node scripts/pubmed-exact.mjs --file consulta.txt          la consulta, leída de un fichero
 *
 * Imprime un recibo JSON por pasada. Sale 0 si la integridad es `verified`, 1 si es `failed` o
 * `unsupported`, 3 si hubo fallo de transporte. Con `NCBI_API_KEY` en el entorno la usa y lo dice,
 * pero nunca la escribe en el recibo: una clave da cuota, no integridad.
 *
 * POR QUÉ EXISTE. El repositorio ya sabía ejecutar ESearch como manda su contrato (`esearch.mjs`) y
 * juzgar la respuesta (`inspectResponse`), pero solo lo hacía para barrer sus propios filtros. Una
 * superficie con shell y red no necesita otro motor ni un MCP: necesita esto. Lo que una superficie
 * conversacional sin shell no puede ejecutar aquí, se le entrega a quien sí pueda.
 *
 * QUÉ NO HACE, a propósito. No reescribe, sanea, normaliza ni trocea la consulta: lo que se envía es
 * byte a byte lo que se recibe, y `sent_query_sha256` lo deja comprobable. No pagina más allá de la
 * primera ventana de ESearch: si el recuento supera lo recuperado, `records_complete` es false y se
 * dice. No lee abstracts: la profundidad de lectura no es suya y no la declara.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectResponse } from './parse-filter.mjs';
import { esearch, ESEARCH_URL, TransportError } from './esearch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = join(ROOT, 'neurosymbolic_router.json');

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

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

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
export async function runExact(term, { retmax = 0, apiKey = '', fetcher, now = () => new Date() } = {}) {
  if (typeof term !== 'string' || term.trim() === '') throw new Error('La consulta está vacía.');
  if (!Number.isSafeInteger(retmax) || retmax < 0 || retmax > ESEARCH_WINDOW) {
    throw new Error(`retmax debe ser un entero entre 0 y ${ESEARCH_WINDOW}.`);
  }
  const params = { retmax: String(retmax), tool: 'pubmed-filters-exact', ...(apiKey ? { api_key: apiKey } : {}) };
  const executedAt = now().toISOString();
  const { transport, esearchresult, raw } = await esearch(term, { params, ...(fetcher ? { fetcher } : {}) });

  const r = esearchresult ?? {};
  const inspection = inspectResponse(esearchresult, { sentQuery: term });
  const count = inspection.countIsValid ? Number(r.count) : null;
  const pmids = Array.isArray(r.idlist) ? r.idlist.map(String) : [];

  return {
    executed_at: executedAt,
    engine: 'scripts/pubmed-exact.mjs',
    endpoint: ESEARCH_URL,
    sent_query: term,
    sent_query_sha256: sha256(term),
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
    pmid_list_sha256: sha256(pmids.join('\n')),
    querytranslation: r.querytranslation ?? null,
    warninglist: r.warninglist ?? null,
    errorlist: r.errorlist ?? null,
    fatal_error: r.ERROR ?? null,
    raw_response_sha256: sha256(raw),
    pagination_notices: inspection.pagination,
    status: { query_integrity: queryIntegrity(inspection) },
    problems: inspection.problems,
  };
}

/** Lo que provenance.record_per_run pide fijar una vez por ejecución. */
export function runContext() {
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  const status = git('status', '--porcelain');
  const routerText = readFileSync(ROUTER, 'utf8');
  return {
    contract_version: JSON.parse(routerText).conformance?.contract_version ?? null,
    repository: 'ernestobarrera/pubmed-filters',
    repository_commit: git('rev-parse', 'HEAD'),
    repository_dirty: status === null ? null : status !== '',
    router_sha256: sha256(routerText),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args.splice(i, 2)[1];
  };
  const file = opt('--file');
  const retmax = Number(opt('--retmax') ?? 0);
  const term = file ? readFileSync(file, 'utf8').trim() : args.join(' ');
  if (!term) {
    console.error("Uso: node scripts/pubmed-exact.mjs '<consulta>' [--retmax N] | --file consulta.txt");
    process.exit(2);
  }
  const run = runContext();
  try {
    const receipt = await runExact(term, { retmax, apiKey: process.env.NCBI_API_KEY ?? '' });
    console.log(JSON.stringify({ run, ...receipt }, null, 2));
    process.exitCode = receipt.status.query_integrity === 'verified' ? 0 : 1;
  } catch (e) {
    const transportFailure = e instanceof TransportError;
    console.log(JSON.stringify({
      run,
      sent_query: term,
      transport_failure: transportFailure,
      error: String(e.message ?? e),
      result_count: null,
    }, null, 2));
    process.exitCode = transportFailure ? 3 : 2;
  }
}
