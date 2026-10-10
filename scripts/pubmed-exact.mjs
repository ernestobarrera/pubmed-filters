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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TransportError } from './esearch.mjs';
import { runExact, sha256 } from './exact-core.mjs';

// El núcleo vive en exact-core.mjs, compartido con el MCP; se reexporta para no romper a quien lo importa de aquí.
export { ESEARCH_WINDOW, queryIntegrity, runExact, sha256 } from './exact-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = join(ROOT, 'neurosymbolic_router.json');

/** Lo que provenance.record_per_run pide fijar una vez por ejecución. */
export async function runContext() {
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
    router_sha256: await sha256(routerText),
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
  const run = await runContext();
  try {
    const receipt = await runExact(term, {
      retmax, apiKey: process.env.NCBI_API_KEY ?? '', email: process.env.NCBI_EMAIL ?? '',
    });
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
