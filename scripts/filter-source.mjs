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

export async function buildFilterBundle(root) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const router = JSON.parse(read('neurosymbolic_router.json'));
  const catalog = buildCatalog(root);
  const c = router.composition ?? {};

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
    guidance: {
      roles: c.roles ?? null,
      facet_roles: c.facet_roles ?? null,
      scope_roles: c.scope_roles ?? null,
      catalog_check: c.catalog_check ?? null,
      geographic_filters: c.geographic_filters ?? null,
      negation_rule: c.negation_filters?.rule ?? null,
      embedded_date_rule: c.embedded_date_limits?.rule ?? null,
    },
    catalog,
    filters,
  };
}
