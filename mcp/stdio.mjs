#!/usr/bin/env node
/**
 * MCP local por stdio: lo arranca y lo cierra tu cliente (Claude Desktop, Claude Code, VS Code).
 * No abre puertos ni escucha en red: solo habla con el programa que lo lanzó y con PubMed.
 *
 *   node mcp/stdio.mjs
 *
 * Con NCBI_API_KEY en el entorno la usa (10 peticiones/s en vez de 3) y nunca la escribe en ningún
 * recibo. Detrás de un proxy corporativo, lánzalo con NODE_USE_ENV_PROXY=1.
 *
 * Mensajes JSON-RPC delimitados por salto de línea en stdin/stdout, como pide el transporte stdio de
 * MCP. Todo lo que no es protocolo va a stderr: una línea suelta en stdout rompería el canal.
 */

import { createInterface } from 'node:readline';
import { createMcpHandler } from './protocol.mjs';
import { runContext } from '../scripts/pubmed-exact.mjs';

const run = await runContext().catch(() => null);
const handle = createMcpHandler({
  apiKey: process.env.NCBI_API_KEY ?? '', email: process.env.NCBI_EMAIL ?? '', run, engine: 'mcp/stdio.mjs',
});
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set();
rl.on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
    return;
  }
  const p = handle(message)
    .then((response) => { if (response) send(response); })
    .catch((e) => {
      process.stderr.write(`pubmed-filters-exact: ${e?.stack ?? e}\n`);
      if (message?.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Error interno' } });
    })
    .finally(() => pending.delete(p));
  pending.add(p);
});
// Al cerrar stdin, termina las llamadas en curso antes de salir.
rl.on('close', async () => { await Promise.allSettled([...pending]); process.exit(0); });
process.stderr.write(`pubmed-filters-exact MCP (stdio) listo · contrato ${run?.contract_version ?? '?'} · commit ${run?.repository_commit?.slice(0, 7) ?? '?'}\n`);
