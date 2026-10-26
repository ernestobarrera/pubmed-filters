/**
 * La fuente simbólica que sirve el MCP: el catálogo, la guía de composición por papel y la consulta
 * canónica de cada filtro, extraída por el parser de referencia.
 *
 * POR QUÉ EXISTE. Una superficie conversacional tenía que descargar cada `.txt` de Pages y extraer la
 * consulta por su cuenta, que es justo donde la suite documenta los fallos caros: quedarse con la
 * primera línea de un filtro multilínea, colar el bloque de metadatos en la consulta, reconstruir el
 * filtro de memoria. Y no podía listar los filtros (Pages no lista carpetas). Con esto, el MCP entrega
 * la consulta tal como la extrae el parser de referencia, con su hash, y el recibo puede comprobar
 * que lo que se envió la contiene literalmente (filter_fidelity).
 *
 * Lo usan `mcp/stdio.mjs` (al arrancar, desde el disco) y `mcp/stamp.mjs` (que lo sella en
 * `mcp/filters-bundle.mjs` para el Worker, que no tiene disco). Un solo constructor, dos transportes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFilter } from './parse-filter.mjs';
import { buildCatalog, serialize } from './catalog.mjs';
import { sha256 } from './exact-core.mjs';

/**
 * Qué parte del router viaja en `guidance`, por ruta. Con las descripciones de las herramientas, es lo
 * único del router que lee una superficie sin terminal: medido el 2026-10-26, 6,6 de 87 KB. Cada clave
 * se sirve tal cual, sin segunda redacción. Qué regla llega por qué canal lo declara
 * `mcp/surface-channels.json`, y `mcp/test.mjs` (M27) lo comprueba.
 */
export const GUIDANCE_PATHS = {
  roles: 'composition.roles',
  facet_roles: 'composition.facet_roles',
  scope_roles: 'composition.scope_roles',
  catalog_check: 'composition.catalog_check',
  geographic_filters: 'composition.geographic_filters',
  negation_rule: 'composition.negation_filters.rule',
  embedded_date_rule: 'composition.embedded_date_limits.rule',
  // 1.14.1: orden, guías y recencia (auditoría de lumbalgia del 26/10). Escritas solo en la prosa del
  // router, no tenían ninguna vía de llegada a ChatGPT.
  order_hides_by_age: 'reading_and_drilldown.order_hides_by_age',
  pagination_order_recommendation: 'reading_and_drilldown.pagination.order_recommendation',
  condition_guideline_pass: 'evidence_landscape_policy.condition_guideline_pass',
  recency_before_closing: 'saturation_policy.recency_before_closing',
  // 1.15.0: cribar por título decide qué se lee, nunca qué se destaca (diseño 33-, §3).
  title_screen: 'reading_and_drilldown.title_screen',
};

/** El valor del router en una ruta con puntos, o undefined si algún tramo no existe. */
export const routerValue = (router, path) => path.split('.').reduce((o, k) =>
  (o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), router);

export async function buildFilterBundle(root) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const router = JSON.parse(read('neurosymbolic_router.json'));
  const catalog = buildCatalog(root);

  const filters = {};
  for (const f of catalog.filters) {
    const query = parseFilter(read(f.path));
    filters[f.path] = { query, query_sha256: await sha256(query), source: f.path };
  }
  // Las listas de revistas: manda journal_filters_data.js (sources.journal_registry), no el espejo .txt.
  const js = read('journal_filters_data.js');
  const jr = JSON.parse(js.slice(js.indexOf('{'), js.indexOf('\n};') + 2));
  for (const j of catalog.journal_lists) {
    const query = jr[j.id].query;
    filters[j.path] = { query, query_sha256: await sha256(query), source: 'journal_filters_data.js' };
  }

  return {
    contract_version: router.conformance?.contract_version ?? null,
    catalog_sha256: await sha256(serialize(catalog)),
    guidance: Object.fromEntries(Object.entries(GUIDANCE_PATHS).map(([k, p]) => [k, routerValue(router, p) ?? null])),
    catalog,
    filters,
  };
}
