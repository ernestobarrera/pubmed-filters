#!/usr/bin/env node
/**
 * Une las páginas de un recorrido y dice qué garantía tiene la unión (1.13.0, especificación 18-, A.4).
 *
 *   node scripts/page-union.mjs recibo-p1.json recibo-p2.json ...
 *
 * Imprime un JSON y sale 0 si la unión es una «recuperación operativa sin instantánea fijada», 1 si es
 * incompleta. Vive FUERA del servidor a propósito: el MCP no guarda nada entre llamadas, así que cada
 * página es independiente y solo quien las tiene todas puede compararlas.
 *
 * QUÉ GARANTIZA. Que las páginas son de la misma consulta y el mismo orden, del mismo recorrido declarado,
 * contiguas desde 0, verificadas, completas en su tramo, servidas en la posición pedida, con el mismo
 * recuento y sin PMID repetidos, y que la unión cuenta lo que PubMed dice que hay.
 *
 * QUÉ RECIBOS UNE. Solo los que llevan registro de selección con plan_ref y pass_id: en esta iteración,
 * los del MCP. Los del CLI (`pubmed-exact.mjs`) no lo llevan y no se pueden unir aquí; inventarles un
 * registro después de los resultados sería justo lo que el registro existe para evitar.
 *
 * QUÉ NO GARANTIZA, y no puede. Que el conjunto no cambiara entre páginas. El contraejemplo de Codex: el
 * conjunto A, B, C, D pasa a A, C, D, E entre la página 1 (A, B) y la 2 (D, E). El recuento sigue en 4, la
 * unión tiene 4 sin duplicados y C se ha perdido con todos los controles en verde. Sin el historial de NCBI
 * (WebEnv), que queda fuera de esta iteración, ningún algoritmo lo detecta. Por eso el resultado nunca se
 * llama «completo» ni «exhaustivo»: un producto que necesite un conjunto fijo y reproducible (un mapa o un
 * cribado publicable) declara esta limitación o usa el historial.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESEARCH_WINDOW, pageAdjusted } from './exact-core.mjs';

export const OPERATIONAL = 'operational_retrieval_without_snapshot';
export const OPERATIONAL_LABEL = 'recuperación operativa sin instantánea fijada';

/**
 * La referencia del recorrido sale del registro de selección que el recibo devuelve: el PAR plan y pasada,
 * los dos obligatorios aquí (el MCP admite registros sin plan; quien certifica una agrupación no). Dos
 * exploraciones independientes con los mismos parámetros no se funden por accidente: sin referencia
 * completa, no hay recorrido que unir. El par se serializa como tupla: concatenarlo con un separador hacía
 * iguales («a#b», «c») y («a», «b#c»), y un plan ausente se volvía cadena vacía (Codex, R2, 2026-10-20).
 */
const walkRef = (r) => {
  const rec = r?.selection_record?.record;
  return rec?.plan_ref && rec?.pass?.pass_id ? JSON.stringify([rec.plan_ref, rec.pass.pass_id]) : null;
};

export function checkPageUnion(receipts) {
  const problems = [];
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { status: 'incomplete', label: null, problems: ['no hay páginas'], pmids: [] };
  }
  const pages = [...receipts].sort((a, b) => (a?.request?.retstart ?? 0) - (b?.request?.retstart ?? 0));
  const first = pages[0];

  // 0. Un mismo recorrido declarado.
  const refs = new Set(pages.map(walkRef));
  if (refs.has(null)) problems.push('recorrido: hay páginas sin registro de selección con plan_ref y pass_id; no se sabe si son del mismo recorrido');
  else if (refs.size > 1) problems.push(`recorrido: las páginas son de recorridos distintos (${[...refs].join(', ')})`);

  // 1. Misma consulta y mismo orden.
  if (new Set(pages.map((p) => p.sent_query_sha256)).size > 1) problems.push('consulta: las páginas no son de la misma consulta (sent_query_sha256)');
  if (new Set(pages.map((p) => p.request?.sort ?? null)).size > 1) problems.push('orden: las páginas no piden el mismo sort');

  // 3. Todas verificadas. 5. Mismo recuento.
  const bad = pages.filter((p) => p.status?.query_integrity !== 'verified');
  if (bad.length) problems.push(`integridad: ${bad.length} página(s) no verified`);
  const counts = new Set(pages.map((p) => p.result_count));
  if (counts.size > 1) problems.push(`recuento: cambia entre páginas (${[...counts].join(', ')})`);
  const count = first.result_count;

  // 2. Inicio en 0 y continuidad. 4. Cada página completa en su tramo.
  let expected = 0;
  for (const p of pages) {
    const start = p.request?.retstart ?? 0;
    const n = Array.isArray(p.pmids) ? p.pmids.length : 0;
    if (start !== expected) problems.push(`continuidad: la página que empieza en ${start} debía empezar en ${expected}`);
    const full = Math.min(p.request?.retmax_sent ?? 0, Math.max(0, (p.result_count ?? 0) - start));
    if (n !== full) problems.push(`página ${start + 1}: ${n} PMID donde su tramo pedía ${full}`);
    // La posición pedida no es la servida si NCBI dice otra: la integridad de la consulta no lo cubre.
    if (pageAdjusted(p.pagination_notices, start, p.request?.retmax_sent)) {
      problems.push(`página ${start + 1}: NCBI dice haber servido otra posición u otro tamaño (${(p.pagination_notices ?? []).join(' | ')})`);
    }
    expected = start + n;
  }

  // 6. Sin duplicados, y la unión cuenta lo que hay cuando cabe en la ventana.
  const all = pages.flatMap((p) => p.pmids ?? []);
  const union = [...new Set(all)];
  if (union.length !== all.length) problems.push(`duplicados: ${all.length - union.length} PMID repetidos entre páginas`);
  if (typeof count !== 'number') problems.push('recuento: no hay result_count utilizable');
  else if (count > ESEARCH_WINDOW) problems.push(`ventana: ${count} registros, y ESearch solo sirve ${ESEARCH_WINDOW}; el resto no es accesible por esta vía`);
  else if (union.length !== count) problems.push(`unión: ${union.length} PMID para ${count} registros`);

  const ok = problems.length === 0;
  return {
    status: ok ? OPERATIONAL : 'incomplete',
    label: ok ? OPERATIONAL_LABEL : null,
    walk_ref: refs.size === 1 ? [...refs][0] : null,
    pages: pages.length,
    result_count: typeof count === 'number' ? count : null,
    union_size: union.length,
    problems,
    not_guaranteed: 'que el conjunto sea el mismo entre páginas: un recuento constante y una unión igual al recuento no lo prueban',
    pmids: union,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Uso: node scripts/page-union.mjs recibo-p1.json recibo-p2.json ...');
    process.exit(2);
  }
  // Un recibo del MCP llega envuelto (result.structuredContent); uno del CLI, tal cual.
  const unwrap = (j) => j?.result?.structuredContent ?? j?.structuredContent ?? j;
  const result = checkPageUnion(files.map((f) => unwrap(JSON.parse(readFileSync(f, 'utf8')))));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === OPERATIONAL ? 0 : 1;
}
