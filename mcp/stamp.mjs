#!/usr/bin/env node
/**
 * Sella el despliegue: escribe mcp/build-info.mjs con lo que provenance.record_per_run pide (versión
 * de contrato, commit, si el árbol estaba sucio, hash del router). El Worker no tiene git ni disco en
 * Cloudflare, así que lo que no se selle aquí no podrá aparecer en sus recibos.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContext } from '../scripts/pubmed-exact.mjs';

const info = { ...(await runContext()), deployed_at: new Date().toISOString() };
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'build-info.mjs'),
  `// Generado por mcp/stamp.mjs. No editar ni versionar.\nexport default ${JSON.stringify(info, null, 2)};\n`);
console.log(`sellado: contrato ${info.contract_version} · commit ${info.repository_commit?.slice(0, 7)}`
  + `${info.repository_dirty ? ' · AVISO: hay cambios sin commit; los recibos lo dirán (repository_dirty: true)' : ''}`);
