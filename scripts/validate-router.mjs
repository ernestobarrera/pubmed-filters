#!/usr/bin/env node
/**
 * Suite de conformidad de este repositorio.
 *
 * Dos partes:
 *   A. El contrato de lectura de un filtro, contra fixtures adversariales. Cualquier superficie
 *      que reimplemente el parser debe pasar estas mismas pruebas para declararse conforme.
 *   B. La coherencia de `neurosymbolic_router.json` con lo que el repositorio contiene de verdad.
 *
 * Uso:  node scripts/validate-router.mjs
 * Sale: 0 si todo pasa, 1 si algo falla.
 *
 * Lo que esta suite NO prueba, dicho para que nadie confíe de más: no comprueba que una superficie
 * componga bien una búsqueda real, ni que interprete la evidencia, ni que los principios se
 * apliquen. Comprueba contradicciones entre lo declarado y lo que hay, que es un subconjunto.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFilter, parseMetadata, isNegation, compose, hasEmbeddedDateLimit, inspectResponse, MARKER }
  from './parse-filter.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'scripts', 'fixtures');
const pass = [];
const fail = [];

const check = (id, ok, detail) => (ok ? pass : fail).push(`${id}  ${detail}`);
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

// ---------------------------------------------------------------------------------------------
// A. Contrato de lectura del fichero de filtro
// ---------------------------------------------------------------------------------------------

check('P1', parseFilter(fixture('multilinea.txt')) === '(primera[tiab] OR segunda[tiab] OR tercera[tiab])',
  'multilínea: se unen TODAS las líneas de la consulta, no solo la primera');

check('P2', !parseFilter(fixture('multilinea.txt')).includes('validation'),
  'el bloque de metadatos no entra en la consulta');

check('P3', parseFilter(fixture('marcador-en-comentario.txt')) === '(consulta[tiab])',
  'el corte es por línea exacta: un marcador citado en un comentario no trunca el filtro');

check('P4', parseFilter(fixture('crlf.txt')) === '(alfa[tiab] OR beta[tiab])',
  'CRLF se trata igual que LF');

check('P5', parseFilter(fixture('sin-metadatos.txt')) === '(solo[tiab] OR consulta[tiab])',
  'un fichero sin marcador devuelve su consulta completa');

check('P6', parseMetadata(fixture('sin-metadatos.txt')) === null
  && parseMetadata(fixture('multilinea.txt'))?.validation?.reference !== undefined,
  'el bloque de validación se lee cuando existe y es null cuando no');

const excl = parseFilter(fixture('exclusion.txt'));
check('N1', isNegation(excl), 'una consulta que empieza por NOT se reconoce como exclusión');
check('N2', compose('tema[tiab]', excl) === `(tema[tiab]) ${excl}`,
  'una exclusión se compone SIN AND');
check('N3', !compose('tema[tiab]', excl).includes('AND (NOT'),
  'nunca se genera `AND (NOT ...)`, que PubMed traduce como inclusión');
check('N4', compose('tema[tiab]', '(Therapy/Narrow[filter])') === '(tema[tiab]) AND ((Therapy/Narrow[filter]))',
  'un filtro normal sí se compone con AND');

check('D1', hasEmbeddedDateLimit(parseFilter(fixture('fecha-embebida.txt'))),
  'se detecta el recorte temporal escondido dentro de la cadena del filtro');
check('D2', !hasEmbeddedDateLimit(parseFilter(fixture('multilinea.txt'))),
  'no se marca recorte temporal donde no lo hay');

// Juicio de una respuesta de PubMed, contra respuestas REALES capturadas de E-utilities.
const respuestas = JSON.parse(readFileSync(join(FIXTURES, 'respuestas-pubmed.json'), 'utf8'));
const juicio = (k) => inspectResponse(respuestas[k].esearchresult);

const roto = juicio('mesh-inexistente');
check('Q1', !roto.usable && roto.dropped.length === 1
  && roto.problems.some((p) => p.startsWith('CERO_ROTO')),
  'un encabezado MeSH inexistente se caza por quotedphrasesnotfound, aunque PubMed no dé error');

check('Q2', juicio('consulta-valida').usable === true,
  'una consulta válida con resultados se declara utilizable');

const cero = juicio('cero-legitimo');
check('Q3', cero.usable === true && cero.dropped.length === 0,
  'un cero legítimo no se confunde con una consulta rota');

const ciego = juicio('aviso-perdido-por-rettype-count');
check('Q4', ciego.verifiable === false && !ciego.usable
  && ciego.problems.some((p) => p.startsWith('NO_VERIFICABLE')),
  'pedida con rettype=count, la misma consulta rota se declara NO VERIFICABLE en vez de limpia');

// ---------------------------------------------------------------------------------------------
// B. Coherencia del router con el repositorio
// ---------------------------------------------------------------------------------------------

const router = JSON.parse(read('neurosymbolic_router.json'));

const paths = {};
for (const [cat, items] of Object.entries(router.filter_registry)) {
  for (const [k, p] of Object.entries(items)) paths[`${cat}.${k}`] = p;
}
const query = (p) => parseFilter(read(p));

const missing = Object.entries(paths).filter(([, p]) => !existsSync(join(ROOT, p)));
check('R1', missing.length === 0,
  `rutas del registry (${Object.keys(paths).length}): ${missing.length === 0 ? 'todas existen' : JSON.stringify(missing)}`);

const refs = new Set();
const walk = (o) => {
  if (Array.isArray(o)) o.forEach(walk);
  else if (o && typeof o === 'object') Object.values(o).forEach(walk);
  else if (typeof o === 'string' && /^(methodology|clinical|scope)\.[a-z_]+$/.test(o)) refs.add(o);
};
walk(router.routing);
walk(router.composition);
const unresolved = [...refs].filter((r) => !(r in paths));
check('R2', unresolved.length === 0,
  `referencias punteadas (${refs.size}): ${unresolved.length === 0 ? 'todas resuelven' : JSON.stringify(unresolved)}`);

const negations = Object.entries(paths).filter(([, p]) => isNegation(query(p))).map(([k]) => k).sort();
const declared = [...(router.composition.negation_filters?.affected_registry_entries ?? [])].sort();
check('R3', JSON.stringify(negations) === JSON.stringify(declared),
  `filtros NOT del registry: repo ${JSON.stringify(negations)} / declarados ${JSON.stringify(declared)}`);

const dated = Object.entries(paths).filter(([, p]) => hasEmbeddedDateLimit(query(p))).map(([k]) => k);
check('R4', dated.length === 0,
  `recorte temporal embebido en el registry: ${dated.length === 0 ? 'ninguno' : JSON.stringify(dated)}`);

const js = read('journal_filters_data.js');
const journals = JSON.parse(js.slice(js.indexOf('{'), js.indexOf('\n};') + 2));
const knownMismatch = router.sources.journal_registry.known_mismatches ?? {};
const declaredMismatch = new Set([
  ...(knownMismatch.txt_disagrees_with_js ?? []),
  ...(knownMismatch.txt_without_js_entry ?? []),
]);
// Los ids que el router USA para enrutar, no los que solo nombra para declarar una divergencia.
const usedIds = [...new Set(JSON.stringify(router).match(/jnl_[a-z0-9_]+/g) ?? [])]
  .filter((id) => !declaredMismatch.has(id));
const badJournals = usedIds.filter((id) => !(id in journals) || !existsSync(join(ROOT, `filters/journals/${id}.txt`)));
check('R5', badJournals.length === 0,
  `ids de revistas usados (${usedIds.length}): ${badJournals.length === 0 ? 'existen en el .js y como .txt' : JSON.stringify(badJournals)}`);

const mirrorMismatch = usedIds.filter((id) => {
  const flat = query(`filters/journals/${id}.txt`).replace(/\s+/g, '');
  return flat !== (journals[id]?.query ?? '').replace(/\s+/g, '');
});
check('R6', mirrorMismatch.length === 0,
  `espejo .txt/.js de los ids usados: ${mirrorMismatch.length === 0 ? 'coinciden' : JSON.stringify(mirrorMismatch)}`);

const authorMade = Object.entries(paths)
  .filter(([, p]) => /propia/i.test(read(p))).map(([k]) => k).sort();
const declaredAuthorMade = [...(router.registry_validation?.author_made_not_validated ?? [])].sort();
check('R7', JSON.stringify(authorMade) === JSON.stringify(declaredAuthorMade),
  `filtros sin validación publicada: repo ${JSON.stringify(authorMade)} / declarados ${JSON.stringify(declaredAuthorMade)}`);

const blob = JSON.stringify(router);
const duplicated = Object.entries(paths)
  .filter(([, p]) => query(p).length > 40 && blob.includes(query(p).slice(0, 40))).map(([k]) => k);
check('R8', duplicated.length === 0,
  `booleanos de filtros duplicados dentro del router: ${duplicated.length === 0 ? 'ninguno' : JSON.stringify(duplicated)}`);

const candBad = router.candidate_extensions.filters
  .filter((f) => !f.suggested_path.startsWith('filters/candidates/')).map((f) => f.id);
const candInRegistry = router.candidate_extensions.filters.filter((f) => f.id in paths).map((f) => f.id);
check('R9', candBad.length === 0 && candInRegistry.length === 0
  && router.candidate_extensions.inactive_until_added_to_repo === true,
  'los candidatos apuntan a filters/candidates/, siguen inactivos y no están en el registry');

const required = ['landscape_before_drilldown', 'avoid_single_study_anchoring',
  'retrieve_to_information_saturation', 'breadth_before_depth', 'diversify_before_intensify',
  'adaptive_precision_recall', 'validated_filters_as_symbolic_truth', 'abstract_minimum_evidence_read',
  'provenance_first', 'no_silent_substitution', 'language_separation'];
const have = new Set(router.principles.map((p) => p.id));
const missingPrinciples = required.filter((r) => !have.has(r));
check('R10', missingPrinciples.length === 0,
  `principios exigidos: ${missingPrinciples.length === 0 ? 'los 11 presentes' : JSON.stringify(missingPrinciples)}`);

// ---------------------------------------------------------------------------------------------
// Lo que protege al repositorio de SUS PROPIOS cambios futuros: un filtro nuevo peligroso no
// puede entrar sin declararse, esté o no en el registry. El registry cubre 31 de 48 filtros;
// estas tres comprobaciones miran los 48 y las 73 listas de revistas.
// ---------------------------------------------------------------------------------------------

const allFilters = ['methodology', 'clinical', 'scope', 'candidates'].flatMap((dir) => {
  const d = join(ROOT, 'filters', dir);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.txt')).map((f) => `filters/${dir}/${f}`) : [];
});

const declaredNegations = new Set([
  ...(router.composition.negation_filters?.affected_registry_entries ?? []).map((k) => paths[k]),
  ...(router.composition.negation_filters?.also_in_repository_outside_registry ?? []),
]);
const undeclaredNegations = allFilters.filter((f) => isNegation(query(f)) && !declaredNegations.has(f));
check('R11', undeclaredNegations.length === 0,
  `cláusulas de exclusión sin declarar en TODO el repositorio (${allFilters.length} filtros): ${
    undeclaredNegations.length === 0 ? 'ninguna' : JSON.stringify(undeclaredNegations)}`);

const declaredDates = new Set(router.composition.embedded_date_limits?.known_cases ?? []);
const undeclaredDates = allFilters.filter((f) => hasEmbeddedDateLimit(query(f)) && !declaredDates.has(f));
check('R12', undeclaredDates.length === 0,
  `recortes temporales embebidos sin declarar en todo el repositorio: ${
    undeclaredDates.length === 0 ? 'ninguno' : JSON.stringify(undeclaredDates)}`);

const flat = (s) => String(s).replace(/\s+/g, '');
const allJournalTxt = readdirSync(join(ROOT, 'filters', 'journals'))
  .filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4));
const newMismatch = Object.keys(journals)
  .filter((id) => allJournalTxt.includes(id)
    && flat(query(`filters/journals/${id}.txt`)) !== flat(journals[id].query ?? '')
    && !(knownMismatch.txt_disagrees_with_js ?? []).includes(id));
const newOrphans = allJournalTxt
  .filter((id) => !(id in journals) && !(knownMismatch.txt_without_js_entry ?? []).includes(id));
check('R13', newMismatch.length === 0 && newOrphans.length === 0,
  `espejo .txt/.js de las ${allJournalTxt.length} listas: ${
    newMismatch.length === 0 && newOrphans.length === 0
      ? `sin divergencias nuevas (${(knownMismatch.txt_disagrees_with_js ?? []).length + (knownMismatch.txt_without_js_entry ?? []).length} conocidas y declaradas)`
      : `nuevas divergencias ${JSON.stringify(newMismatch)} / nuevos huérfanos ${JSON.stringify(newOrphans)}`}`);

// Clasificación: toda sección de primer nivel tiene exactamente un dueño declarado.
const cls = router.rule_classification ?? {};
const classified = ['mechanical_contract', 'retrieval_policy', 'boundary']
  .flatMap((k) => cls[k] ?? []);
const meta = ['schema_version', 'metadata', 'rule_classification', 'conformance',
  'surface_policy_not_owned_here'];
const sections = Object.keys(router).filter((k) => !meta.includes(k));
const unclassified = sections.filter((s) => !classified.includes(s));
const duplicatedClass = classified.filter((s, i) => classified.indexOf(s) !== i);
const ghost = classified.filter((s) => !sections.includes(s));
check('C1', unclassified.length === 0 && duplicatedClass.length === 0 && ghost.length === 0,
  `clasificación (${sections.length} secciones): ${unclassified.length === 0 && duplicatedClass.length === 0 && ghost.length === 0
    ? 'cada una con un único dueño'
    : `sin clase ${JSON.stringify(unclassified)} / repetidas ${JSON.stringify(duplicatedClass)} / inexistentes ${JSON.stringify(ghost)}`}`);

const qec = router.query_execution_contract ?? {};
check('C3', (qec.inspect_in_every_response ?? []).length >= 4
  && (qec.inspect_in_every_response ?? []).some((f) => f.includes('quotedphrasesnotfound'))
  && (qec.inspect_in_every_response ?? []).some((f) => f.includes('querytranslation')),
  'el router obliga a inspeccionar los avisos que PubMed devuelve en cada consulta');

const rec = router.provenance.record_per_pass ?? [];
check('C4', ['result_count', 'records_retrieved', 'abstracts_read'].every((f) => rec.includes(f))
  && typeof router.provenance.counts_are_not_interchangeable === 'string',
  'la procedencia distingue resultados encontrados, descargados y leídos');

check('C5', typeof router.composition.precision_hints?.rule === 'string'
  && typeof router.evidence_landscape_policy.exact_applicability_pass?.rule === 'string',
  'el fallback de sensibilidad suelta las pistas de precisión, y una pasada devuelve el PICO exacto');

check('C2', typeof router.conformance?.contract_version === 'string'
  && existsSync(join(ROOT, router.conformance.reference_parser))
  && existsSync(join(ROOT, router.conformance.test_suite)),
  'el router declara versión de contrato, parser de referencia y suite, y ambos ficheros existen');

// ---------------------------------------------------------------------------------------------
// C. Autoprueba: las tres formas conocidas de equivocarse deben FALLAR estas pruebas.
//    Una suite que no sabe rechazar una implementación mala no prueba nada.
// ---------------------------------------------------------------------------------------------

const wrong = {
  'solo la primera línea no comentada': (t) => String(t).split(/\r?\n/)
    .find((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))?.trim() ?? '',
  'se traga el bloque de metadatos': (t) => String(t).split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    .map((l) => l.trim()).join(' '),
  'corta por subcadena en vez de por línea': (t) => String(t).split(MARKER)[0]
    .split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    .map((l) => l.trim()).join(' '),
};
const expected = {
  'multilinea.txt': '(primera[tiab] OR segunda[tiab] OR tercera[tiab])',
  'marcador-en-comentario.txt': '(consulta[tiab])',
  'crlf.txt': '(alfa[tiab] OR beta[tiab])',
};
for (const [name, impl] of Object.entries(wrong)) {
  const caught = Object.entries(expected).some(([file, want]) => impl(fixture(file)) !== want);
  check('A1', caught, `la suite rechaza un parser que ${name}`);
}
check('A2', Object.entries(expected).every(([file, want]) => parseFilter(fixture(file)) === want),
  'y acepta la implementación de referencia');

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Inventario: qué hay en el repositorio que el router todavía no conoce. No es un fallo —el
// registry es un subconjunto por diseño— pero es lo que ninguna comprobación puede decidir por ti.
// ---------------------------------------------------------------------------------------------

if (process.argv.includes('--inventory')) {
  const inRegistry = new Set(Object.values(paths));
  const outside = allFilters.filter((f) => !inRegistry.has(f) && !f.startsWith('filters/candidates/'));
  console.log(`\nFiltros del repositorio fuera del registry del router: ${outside.length} de ${allFilters.length}`);
  for (const f of outside) {
    const q = query(f);
    const flags = [
      isNegation(q) ? 'EXCLUSIÓN (se compone sin AND)' : null,
      hasEmbeddedDateLimit(q) ? 'FECHA EMBEBIDA' : null,
      /propia/i.test(read(f)) ? 'sin validación publicada' : null,
    ].filter(Boolean);
    console.log(`  ${f}${flags.length ? '   <- ' + flags.join(' · ') : ''}`);
  }
  console.log('\nAñadir uno al registry es una decisión editorial, no un arreglo automático:');
  console.log('declara su clave semántica en filter_registry y vuelve a pasar la suite.');
}

for (const line of pass) console.log(`  pass  ${line}`);
for (const line of fail) console.log(`  FAIL  ${line}`);
console.log(`\n${pass.length} pass / ${fail.length} fail`);
process.exit(fail.length === 0 ? 0 : 1);
