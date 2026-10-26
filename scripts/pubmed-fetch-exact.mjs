#!/usr/bin/env node
/**
 * Lectura por PMID con recibo: la misma `pubmed_fetch_exact` del MCP, desde un terminal.
 *
 *   node scripts/pubmed-fetch-exact.mjs --plan-ref plan-1/r1 --read-id lectura-1 12848631 16040284
 *
 * Imprime un recibo JSON por llamada (1-5 PMID). Sale 0 si la entrega es `complete`, 1 si es `partial`
 * (pendientes o errores por PMID), 3 si es `failed` y 2 si la petición no es válida. Los PMID van tal
 * cual: un cero a la izquierda o un número que no lo es se rechazan, no se corrigen. Con NCBI_API_KEY y
 * NCBI_EMAIL en el entorno los usa y lo dice, pero nunca los escribe en el recibo.
 *
 * Qué acredita y qué no: lo dice `fetch-core.mjs`. Para unir búsquedas, lecturas y respuesta en un
 * dossier, `scripts/dossier-check.mjs`.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContext } from './pubmed-exact.mjs';
import { runFetch, fetchRequestError } from './fetch-core.mjs';

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args.splice(i, 2)[1];
  };
  const context = { plan_ref: opt('--plan-ref'), read_id: opt('--read-id') };
  const invalid = fetchRequestError(args, context);
  if (invalid) {
    console.error(`${invalid}\nUso: node scripts/pubmed-fetch-exact.mjs --plan-ref <plan> --read-id <lectura> <pmid> [<pmid> ... hasta 5]`);
    process.exit(2);
  }
  const receipt = await runFetch(args, context, {
    run: await runContext(), apiKey: process.env.NCBI_API_KEY ?? '', email: process.env.NCBI_EMAIL ?? '',
  });
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = { complete: 0, partial: 1, failed: 3 }[receipt.status.delivery];
}
