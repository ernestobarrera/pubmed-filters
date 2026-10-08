#!/usr/bin/env node
/**
 * Sella el despliegue: escribe mcp/build-info.mjs con lo que provenance.record_per_run pide (versión
 * de contrato, commit, si el árbol estaba sucio, hash del router) y el SHA-256 de cada fichero de
 * código que va dentro del Worker. El Worker no tiene git ni disco en Cloudflare, así que lo que no se
 * selle aquí no podrá aparecer en sus recibos.
 *
 *   node stamp.mjs            sella (lo usan las pruebas y `wrangler dev`)
 *   node stamp.mjs --deploy   sella para desplegar: se NIEGA si el árbol tiene cambios sin commit
 *
 * Por qué se niega: un commit con el árbol sucio no identifica el código desplegado, y el hash del
 * router tampoco cubre protocol.mjs, worker.mjs ni el ejecutor (revisión de Codex, 2026-10-08). Los
 * hashes de código cierran ese hueco; la negativa evita que haga falta.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContext } from '../scripts/pubmed-exact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEPLOYED_CODE = ['mcp/worker.mjs', 'mcp/protocol.mjs', 'scripts/exact-core.mjs',
  'scripts/parse-filter.mjs', 'scripts/esearch.mjs'];

const run = await runContext();
if (process.argv.includes('--deploy') && run.repository_dirty !== false) {
  console.error(run.repository_dirty === null
    ? 'NO SE DESPLIEGA: no se pudo comprobar git, así que no se sabe qué código sale.'
    : 'NO SE DESPLIEGA: hay cambios sin commit. Haz commit (o descártalos) y vuelve a desplegar.');
  process.exit(1);
}
const code_sha256 = Object.fromEntries(DEPLOYED_CODE.map((f) => [f,
  createHash('sha256').update(readFileSync(join(HERE, '..', f))).digest('hex')]));
const info = { ...run, code_sha256, deployed_at: new Date().toISOString() };
writeFileSync(join(HERE, 'build-info.mjs'),
  `// Generado por mcp/stamp.mjs. No editar ni versionar.\nexport default ${JSON.stringify(info, null, 2)};\n`);
console.log(`sellado: contrato ${info.contract_version} · commit ${info.repository_commit?.slice(0, 7)}`
  + `${info.repository_dirty ? ' · árbol con cambios sin commit (repository_dirty: true)' : ''}`);
