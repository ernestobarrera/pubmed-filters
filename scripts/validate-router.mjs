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
import { parseFilter, parseMetadata, isNegation, compose, hasEmbeddedDateLimit, inspectResponse, MARKER,
  unknownFieldTags, lookalikeCharacters, PUBMED_FIELD_TAGS }
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
const juicio = (k) => inspectResponse(respuestas[k].esearchresult, { sentQuery: respuestas[k].term });

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

const fatal = inspectResponse({ count: '0', querytranslation: 'cancer', ERROR: 'Invalid database name' },
  { sentQuery: 'cancer' });
check('Q5', fatal.usable === false && fatal.problems.some((p) => p.startsWith('ERROR_FATAL')),
  'esearchresult.ERROR invalida la respuesta aunque haya count y querytranslation');

// El término descartado MÁS peligroso: no hay cero, no hay error y el recuento parece razonable.
// Caso real de campo: PubMed tira "body battery"[tiab] dentro de un OR y devuelve 5 resultados,
// los mismos que devolvería la consulta sin ese término.
const conResultados = juicio('termino-descartado-con-resultados');
check('Q6', conResultados.usable === false
  && conResultados.dropped.length === 1
  && Number(respuestas['termino-descartado-con-resultados'].esearchresult.count) > 0
  && !conResultados.problems.some((p) => p.startsWith('CERO_ROTO')),
  'un término descartado se caza aunque la consulta devuelva resultados y no haya ningún cero');

// Un recuento ausente o no numérico no es un recuento. Sin esta puerta, inspectResponse daba
// `usable: true` a una respuesta sin count: luz verde a lo que existe para vigilar.
const recuentos = [
  ['ausente', { querytranslation: 'x' }, false],
  ['no numérico', { count: 'invalid', querytranslation: 'x' }, false],
  ['vacío', { count: '', querytranslation: 'x' }, false],
  ['null', { count: null, querytranslation: 'x' }, false],
  ['negativo', { count: '-3', querytranslation: 'x' }, false],
  ['prefijo numérico', { count: '12abc', querytranslation: 'x' }, false],
  ['solo espacios', { count: '  ', querytranslation: 'x' }, false],
  // `Number()` no es un parser de recuentos: acepta hexadecimal, notación científica, decimales con
  // cero, signo y menos cero. «0x10» pasaba como 16 y «1e3» como 1000. Medido el 2026-10-08.
  ['hexadecimal', { count: '0x10', querytranslation: 'x' }, false],
  ['notación científica', { count: '1e3', querytranslation: 'x' }, false],
  ['decimal con cero', { count: '12.0', querytranslation: 'x' }, false],
  ['con signo', { count: '+5', querytranslation: 'x' }, false],
  ['menos cero', { count: '-0', querytranslation: 'x' }, false],
  ['número no entero', { count: 1.5, querytranslation: 'x' }, false],
  ['válido', { count: '1234', querytranslation: 'x' }, true],
  ['válido como número', { count: 1234, querytranslation: 'x' }, true],
  ['cero legítimo', { count: '0', querytranslation: 'x' }, true],
];
const malos = recuentos.filter(([, r, esperado]) => inspectResponse(r, { sentQuery: 'x' }).usable !== esperado);
check('Q7', malos.length === 0,
  `recuentos malformados (${recuentos.length} casos): ${malos.length === 0
    ? 'ninguno pasa como utilizable y los válidos siguen pasando'
    : JSON.stringify(malos.map(([n]) => n))}`);

// Q8. Lo que PubMed tira SIN NINGÚN AVISO y solo delata la consulta enviada. Todas son respuestas
// reales del 2026-10-08, y en todas PubMed devuelve un recuento plausible con el diagnóstico limpio:
// etiqueta inexistente, la misma con un espacio delante, etiqueta sobre un grupo con operadores,
// modificador en un campo que no lo admite y asterisco tipográfico. Sin la consulta enviada, el juicio
// NO da nada por bueno: la primera versión daba `usable: true` y Q8 lo exigía (Codex, 2026-10-08).
// Segunda ronda de Codex (2026-10-08): asterisco tipográfico dentro de una frase, proximidad sobre una
// frase con comodín y grupo con NOT, más la proximidad sin comillas que salió al corregirlas.
const ignoradas = ['campo-invalido', 'etiqueta-desconocida-con-espacio', 'etiqueta-sobre-grupo',
  'modificador-ignorado', 'asterisco-tipografico', 'asterisco-tipografico-en-frase', 'proximidad-con-comodin',
  'proximidad-sin-comillas', 'etiqueta-sobre-grupo-not'];
const ignoradaComoBuena = ignoradas.filter((k) => juicio(k).usable || juicio(k).anomalies.length === 0);
const sinConsulta = inspectResponse(respuestas['campo-invalido'].esearchresult);
// Y no se marca lo que no es etiqueta. Cada caso «sí» se comprobó contra PubMed el 2026-10-08.
const noSonProblema = ['[18F]FDG[tiab]', '"[18F]FDG"[tiab]', '"asthma control"[tiab:~2]', 'asthma [tiab]',
  'asthma[mesh:noexp]', 'review[pt:noexp]', 'therapy[sh:noexp]', '(asthma)[tiab]', 'Front Endocrinol (Lausanne)[JO]',
  '“mini-mental state”[tiab]', 'alzheimer’s[tiab]', 'asthma[Title/Abstract]', 'asthma/therapy[mh]', 'lancet[jo]',
  '("a OR b")[tiab]', '"asthma control"[ad:~2]', '“asthma control”[Title/Abstract:~3]',
  'asthma[tiab] NOT copd[tiab]'].filter((q) => unknownFieldTags(q).length > 0 || lookalikeCharacters(q).length > 0);
const siSonProblema = ['asthma [tiabb]', 'asthma\t[foo]', '(asthma OR copd)[tiab]', '(asthma|copd) [tiab]',
  'asthma[mh:~3]', 'asthma[ti:noexp]', '"asthma control"[tw:~2]', 'asthma OR [tiab]', 'asthma [author identifier]',
  '(asthma AND copd)[tiab]', '(asthma NOT copd)[tiab]', '"asthma"[tiab:~2]', 'asthma control[tiab:~2]',
  '"asthma* control"[tiab:~2]']
  .filter((q) => unknownFieldTags(q).length === 0)
  .concat(['"randomized trial∗"[tiab]'].filter((q) => lookalikeCharacters(q).length === 0));
check('Q8', juicio('corchete-en-frase').usable === true && ignoradaComoBuena.length === 0
  && sinConsulta.usable === false && sinConsulta.problems.some((p) => p.startsWith('ETIQUETAS_NO_COMPROBADAS'))
  && noSonProblema.length === 0 && siSonProblema.length === 0,
  `lo que PubMed ignora en silencio se caza por la consulta enviada, y sin ella no se da por bueno${
    ignoradaComoBuena.length ? ` — dadas por buenas: ${JSON.stringify(ignoradaComoBuena)}` : ''}${
    noSonProblema.length ? ` — falsos positivos: ${JSON.stringify(noSonProblema)}` : ''}${
    siSonProblema.length ? ` — no detectadas: ${JSON.stringify(siSonProblema)}` : ''}`);

// Q9. «Restrictions achieved» es PubMed recortando la página a su ventana, no un aviso sobre la
// consulta: se informa como paginación y no invalida la integridad. Respuesta real del 2026-10-08.
const recorte = inspectResponse(respuestas['restricciones-ajustadas'].esearchresult,
  { sentQuery: respuestas['restricciones-ajustadas'].term });
const vacia = inspectResponse(respuestas['frase-ignorada-the'].esearchresult);
check('Q9', recorte.usable === true && recorte.pagination.length === 1
  && !recorte.problems.some((p) => p.startsWith('AVISO_SEMANTICO'))
  && vacia.usable === false && vacia.problems.some((p) => p.startsWith('ERRORLIST')),
  'el recorte de página se declara como paginación sin invalidar la consulta; un errorlist real sí la invalida');

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

// Sintaxis booleana de cada filtro. No comprueba que la consulta sea BUENA —eso no lo decide una
// regex— sino que esté bien ESCRITA, que es otra cosa y sí es decidible.
//
// Por qué existe, medido el 2026-10-01: `filters/scope/spanish.txt` llevaba desde 2022 un `O R`
// en lugar de `OR` y dos etiquetas con espacio dentro, `[ ad]`. PubMed no da error con eso: parte
// la consulta y devuelve un recuento plausible. Lo encontró un agente usando el filtro en una
// búsqueda real, no este banco, que miraba exclusiones, fechas y espejos pero nunca si la cadena
// estaba bien formada. Un filtro mal escrito es exactamente el fallo silencioso que este
// repositorio existe para impedir, y vivía dentro del repositorio.
const MALFORMADO = [
  [/\b[A-Z]\s+[A-Z]\b(?!\w)/, 'operador partido en dos letras sueltas, como «O R» en vez de «OR»'],
  [/\[\s+[a-zA-Z]+\s*\]|\[\s*[a-zA-Z]+\s+\]/, 'etiqueta de campo con espacios dentro, como «[ ad]»'],
  [/\b(AND|OR|NOT)\s+(AND|OR|NOT)\b/, 'dos operadores seguidos'],
  [/(^|\()\s*(AND|OR)\b/, 'la consulta o un grupo empieza por un operador'],
  [/\b(AND|OR|NOT)\s*(\)|$)/, 'la consulta o un grupo termina en un operador'],
];
const malEscritos = allFilters.flatMap((f) => {
  const q = query(f);
  const fallos = MALFORMADO.filter(([re]) => re.test(q)).map(([, que]) => que);
  const abre = (q.match(/\(/g) ?? []).length;
  const cierra = (q.match(/\)/g) ?? []).length;
  if (abre !== cierra) fallos.push(`paréntesis descompensados (${abre} abren, ${cierra} cierran)`);
  return fallos.length ? [`${f}: ${fallos.join('; ')}`] : [];
});
check('R14', malEscritos.length === 0,
  `sintaxis booleana de los ${allFilters.length} filtros: ${
    malEscritos.length === 0 ? 'sin anomalías' : JSON.stringify(malEscritos)}`);

// Estado de indexación no es MeSH (baseline PubMed 2027, IndexingMethod="NotIndexed"). Un subconjunto
// de estado usado como proxy de «indexado» deja fuera, en silencio, citas MEDLINE sin MeSH. Ningún
// filtro lo hace hoy; esto impide que empiece a hacerlo sin declararse.
const indexado = router.composition.indexing_status_is_not_mesh ?? {};
const declaradosEstado = new Set(indexado.declared_status_subset_filters ?? []);
const conSubconjuntoDeEstado = [...allFilters,
  ...readdirSync(join(ROOT, 'filters', 'journals')).filter((f) => f.endsWith('.txt')).map((f) => `filters/journals/${f}`)]
  .filter((f) => /\b(medline|inprocess|pubmednotmedline|publisher)\s*\[\s*(sb|subset|filter)\s*\]/i.test(query(f)) && !declaradosEstado.has(f));
check('R15', typeof indexado.rule === 'string' && indexado.rule.includes('NotIndexed')
  && conSubconjuntoDeEstado.length === 0,
  `subconjuntos de estado como proxy de indexación MeSH: ${conSubconjuntoDeEstado.length === 0
    ? 'ningún filtro sin declarar, y la regla NotIndexed está escrita' : JSON.stringify(conSubconjuntoDeEstado)}`);

// Toda etiqueta de campo usada por un filtro del repositorio está en la lista comprobada contra
// E-utilities. Si un filtro trae una errata en una etiqueta, PubMed no lo dirá nunca: lo dice esto.
const todosLosFiltros = [...allFilters, ...readdirSync(join(ROOT, 'filters', 'journals'))
  .filter((f) => f.endsWith('.txt')).map((f) => `filters/journals/${f}`)];
const etiquetasDesconocidas = todosLosFiltros.flatMap((f) => unknownFieldTags(query(f)).map((t) => `${f}: ${t}`));
check('R16', etiquetasDesconocidas.length === 0 && PUBMED_FIELD_TAGS.has('tiab'),
  `etiquetas de campo de los ${todosLosFiltros.length} filtros: ${etiquetasDesconocidas.length === 0
    ? 'todas reconocidas por PubMed' : JSON.stringify(etiquetasDesconocidas)}`);

// Asteriscos que no lo son. Encontrado el 2026-10-08 al rehacer la heurística de etiquetas: horizon.txt
// traía `∗` (U+2217, copiado del PDF del artículo) en seis términos, y PubMed buscaba la raíz exacta sin
// avisar. Ninguna barrida lo vio, porque PubMed no lo reporta. Corregido en V.1.2 (2026-10-09). Un caso
// declarado pasa; uno nuevo, no.
const tipograficos = router.registry_validation?.terms_pubmed_drops?.typographic_truncation ?? {};
const declaradosTipo = new Set(Object.keys(tipograficos.cases ?? {}));
const conFalsoAsterisco = todosLosFiltros.filter((f) => lookalikeCharacters(query(f)).length > 0);
const sinDeclarar = conFalsoAsterisco.filter((f) => !declaradosTipo.has(f));
const declaradoSinCaso = [...declaradosTipo].filter((f) => !conFalsoAsterisco.includes(f));
check('R17', sinDeclarar.length === 0 && declaradoSinCaso.length === 0,
  `asteriscos tipográficos en los filtros: ${sinDeclarar.length === 0 && declaradoSinCaso.length === 0
    ? `ninguno sin declarar (${declaradosTipo.size} declarado${declaradosTipo.size === 1 ? '' : 's'})`
    : `sin declarar ${JSON.stringify(sinDeclarar)} / declarados que ya no lo tienen ${JSON.stringify(declaradoSinCaso)}`}`);

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
  && ['querytranslation', 'warninglist', 'errorlist', 'raw_response_or_sha256', 'pmid_list_or_sha256']
    .every((f) => rec.includes(f))
  && ['contract_version', 'repository_commit', 'repository_dirty', 'router_sha256']
    .every((f) => (router.provenance.record_per_run ?? []).includes(f))
  && typeof router.provenance.counts_are_not_interchangeable === 'string',
  'la procedencia fija contrato/commit y distingue consulta, respuesta, PMIDs y lectura');

check('C5', typeof router.composition.precision_hints?.rule === 'string'
  && typeof router.evidence_landscape_policy.exact_applicability_pass?.rule === 'string',
  'el fallback de sensibilidad suelta las pistas de precisión, y una pasada devuelve el PICO exacto');

check('C2', typeof router.conformance?.contract_version === 'string'
  && existsSync(join(ROOT, router.conformance.reference_parser))
  && existsSync(join(ROOT, router.conformance.test_suite))
  && existsSync(join(ROOT, router.conformance.reference_executor ?? '')),
  'el router declara versión de contrato, parser y ejecutor de referencia y suite, y los tres ficheros existen');

check('C6', ['query_integrity', 'coverage', 'reading_depth']
  .every((d) => (router.provenance.operational_status?.dimensions ?? []).includes(d))
  && ['verified', 'failed', 'planned', 'unsupported']
    .every((s) => (router.provenance.operational_status?.semantic_values ?? []).includes(s)
      && typeof router.provenance.operational_status?.value_meanings?.[s] === 'string'),
  'el estado operativo es semántico, separa integridad, cobertura y lectura, y define cada valor (comprobado y roto ≠ no comprobable)');

// Un vocabulario compartido por tres dimensiones invita a usar un valor donde no significa nada:
// `failed` está definido para la integridad de una consulta, no para «cobertura fallida» ni «lectura
// fallida». Cada dimensión declara sus valores, todos existen en el vocabulario, y `failed` no se
// extiende a otra dimensión sin su propio significado. Lo señaló una revisión externa el 2026-10-08.
const os = router.provenance.operational_status ?? {};
const porDimension = os.values_by_dimension ?? {};
const dimensionesSinLista = (os.dimensions ?? []).filter((d) => !Array.isArray(porDimension[d]));
const valoresHuerfanos = (os.dimensions ?? []).flatMap((d) => (porDimension[d] ?? [])
  .filter((v) => !(os.semantic_values ?? []).includes(v)).map((v) => `${d}:${v}`));
const failedFuera = (os.dimensions ?? []).filter((d) => d !== 'query_integrity' && (porDimension[d] ?? []).includes('failed'));
check('C13', dimensionesSinLista.length === 0 && valoresHuerfanos.length === 0 && failedFuera.length === 0
  && (porDimension.query_integrity ?? []).includes('failed'),
  `valores por dimensión: ${dimensionesSinLista.length === 0 && valoresHuerfanos.length === 0 && failedFuera.length === 0
    ? 'cada dimensión declara los suyos y failed solo vale para query_integrity'
    : `sin lista ${JSON.stringify(dimensionesSinLista)} / inexistentes ${JSON.stringify(valoresHuerfanos)} / failed fuera de sitio ${JSON.stringify(failedFuera)}`}`);

check('C7', typeof qec.rule_for_headings === 'string'
  && qec.rule_for_headings.includes('db=pubmed')
  && qec.rule_for_headings.includes('db=mesh')
  && qec.inspect_in_every_response.includes('esearchresult.ERROR'),
  'MeSH usa db=mesh solo para descubrir y valida el encabezado exacto en db=pubmed');

check('C8', (router.conformance.adapter_conformance?.required_declaration ?? []).length >= 5
  && (router.conformance.adapter_conformance?.minimum_query_vectors ?? []).includes('esearchresult.ERROR'),
  'la conformidad externa exige declaración y pruebas del adaptador, no solo la suite del repositorio');

// Una regla sin su vector es una regla que ningún adaptador está obligado a demostrar. Pasó de
// verdad: la 1.7.1 añadió `count_must_be_a_count` y `dropped_term_with_results` y dejó los vectores
// congelados en los siete de la 1.7, así que el contrato exigía menos de lo que definía. Quien se
// guiara por la lista de vectores —su uso previsto— se habría creído conforme sin cubrirlas.
// Esto lo convierte en un fallo de la suite en vez de en un descubrimiento por accidente.
const vectores = router.conformance.adapter_conformance?.minimum_query_vectors ?? [];
const prosaDeclarada = router.conformance.adapter_conformance?.guiding_prose_not_a_vector ?? [];
const reglasSinVector = Object.keys(qec)
  .filter((regla) => !vectores.includes(regla) && !prosaDeclarada.includes(regla));
check('C9', reglasSinVector.length === 0 && prosaDeclarada.length > 0,
  `toda regla de query_execution_contract tiene su vector o se declara prosa rectora${
    reglasSinVector.length ? ` — sin vector: ${reglasSinVector.join(', ')}` : ''}`);

// Perfiles de superficie: una capacidad que ningún perfil declara es una capacidad que ninguno puede
// reclamar, y un perfil que dice aplicarlo todo sin tenerlas todas miente. La 1.8 añadió
// `execution_diagnostics`: sin esta comprobación, olvidarla en el perfil completo pasaba en verde.
const perfiles = router.surface_profiles?.profiles ?? {};
const capacidades = router.surface_profiles?.capabilities ?? [];
const capacidadFantasma = Object.entries(perfiles)
  .flatMap(([n, p]) => (p.has ?? []).filter((c) => !capacidades.includes(c)).map((c) => `${n}:${c}`));
const todoSinTodo = Object.entries(perfiles)
  .filter(([, p]) => p.applies === 'all' && !capacidades.every((c) => (p.has ?? []).includes(c)))
  .map(([n]) => n);
check('C10', capacidadFantasma.length === 0 && todoSinTodo.length === 0,
  `perfiles de superficie: ${capacidadFantasma.length === 0 && todoSinTodo.length === 0
    ? 'toda capacidad declarada existe y «applies: all» las tiene todas'
    : `capacidades inexistentes ${JSON.stringify(capacidadFantasma)} / «all» incompleto ${JSON.stringify(todoSinTodo)}`}`);

// Ejecutar sin poder ver lo ejecutado es un estado propio, no una variante del perfil completo: la
// superficie devuelve registros reales y aun así no puede sostener una afirmación con ellos. Se
// comprueba en campos que un adaptador puede leer, no en prosa: la primera versión buscaba la palabra
// «coverage» y una prohibición reducida a esa sola palabra pasaba en verde.
const estados = router.provenance.operational_status ?? {};
const ciega = Object.entries(perfiles).filter(([, p]) => (p.has ?? []).includes('literal_pubmed_execution')
  && !(p.has ?? []).includes('execution_diagnostics'));
const ciegaMal = ciega.filter(([, p]) => p.operational_status?.query_integrity !== 'unsupported'
  || p.counts_as_coverage !== false).map(([n]) => n);
check('C11', ciega.length > 0 && ciegaMal.length === 0
  && (estados.semantic_values ?? []).includes('unsupported')
  && (estados.dimensions ?? []).includes('query_integrity'),
  `ejecutar PubMed sin ver su diagnóstico: ${ciega.length > 0 && ciegaMal.length === 0
    ? 'perfil propio con query_integrity unsupported y counts_as_coverage false'
    : `perfil ausente o incompleto ${JSON.stringify(ciegaMal)}`}`);

// El repositorio cumple su propia regla de transporte, y se comprueba la petición ENTREGADA, no el
// texto que la construye. La primera versión de C12 buscaba la cadena `method: 'POST'`: una revisión
// externa cambió quickstart.mjs a un GET real, dejó esa cadena en un comentario y la suite siguió en
// verde. Ahora hay dos partes:
//   a) toda llamada a ESearch pasa por scripts/esearch.mjs, y ningún otro script nombra el servicio;
//   b) esearch() se ejecuta contra un fetcher de prueba, con una consulta corta y otra larga de verdad
//      (tema de 950 caracteres + filtro de síntesis), y se exige POST, `term` fuera de la URL y el
//      cuerpo idéntico a la consulta. Así caen un GET, un GET condicional para consultas cortas y un
//      truncado. Un 414 simulado debe acabar en fallo de transporte, nunca en un recuento.
const ESEARCH_MODULE = 'scripts/esearch.mjs';
const scriptsConServicio = readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs'))
  .map((f) => `scripts/${f}`)
  .filter((f) => f !== router.conformance.test_suite && f !== ESEARCH_MODULE
    && /eutils\.ncbi\.nlm\.nih\.gov|esearch\.fcgi/.test(read(f)));
const ejecutanSinModulo = ['scripts/quickstart.mjs', 'scripts/sweep-filters.mjs', 'scripts/exact-core.mjs']
  .filter((f) => !/from '\.\/esearch\.mjs'/.test(read(f)));
check('C12', scriptsConServicio.length === 0 && ejecutanSinModulo.length === 0,
  `ESearch solo se llama desde ${ESEARCH_MODULE}: ${scriptsConServicio.length === 0 && ejecutanSinModulo.length === 0
    ? 'sí' : `servicio nombrado fuera ${JSON.stringify(scriptsConServicio)} / sin el módulo ${JSON.stringify(ejecutanSinModulo)}`}`);

const { esearch, TransportError } = await import('./esearch.mjs');
const entregadas = [];
const fetcherDePrueba = (status = 200) => async (url, init = {}) => {
  entregadas.push({ url: String(url), method: init.method ?? 'GET', body: init.body?.toString() ?? '' });
  return { ok: status === 200, status, text: async () => JSON.stringify({ esearchresult: { count: '1', querytranslation: 'x' } }) };
};
const temaLargo = `(${Array.from({ length: 60 }, (_, i) => `"termino clinico ${i}"[tiab]`).join(' OR ')})`.slice(0, 950);
const consultas = {
  corta: 'asthma[tiab]',
  larga: compose(compose(temaLargo, query('filters/methodology/metaanalysis.txt')),
    query('filters/methodology/clinical_rules_ap.txt')),
};
// La consulta larga tiene que superar de verdad lo que GET transporta: 414 medido a 5.343 caracteres
// URL-encoded contra E-utilities. Si no, la prueba no distingue POST de GET.
const codificada = new URLSearchParams({ term: consultas.larga }).toString().length;
const malEntregadas = [];
for (const [nombre, term] of Object.entries(consultas)) {
  entregadas.length = 0;
  await esearch(term, { params: { retmax: '0' }, fetcher: fetcherDePrueba() });
  const p = entregadas[0];
  const ok = entregadas.length === 1 && p.method === 'POST'
    && !new URL(p.url).searchParams.has('term')
    && new URLSearchParams(p.body).get('term') === term;
  if (!ok) malEntregadas.push(nombre);
}
check('T1', malEntregadas.length === 0 && codificada > 5343,
  `petición entregada, consulta corta y larga (${codificada} caracteres codificados): ${malEntregadas.length === 0
    ? 'POST, term en el cuerpo e íntegro' : `mal transportadas ${JSON.stringify(malEntregadas)}`}`);

let resultado414;
try {
  resultado414 = await esearch(consultas.larga, { fetcher: fetcherDePrueba(414) });
} catch (e) {
  resultado414 = e;
}
check('T2', resultado414 instanceof TransportError,
  'un HTTP 414 acaba en fallo de transporte declarado, no en un recuento ni en «no evaluable»');

// ---------------------------------------------------------------------------------------------
// E. El ejecutor de referencia y su recibo (scripts/pubmed-exact.mjs).
//    Se alimenta con las respuestas REALES de fixtures/respuestas-pubmed.json, servidas byte a byte
//    por un fetcher de prueba: lo que se mira es el recibo que saldría de cada una.
// ---------------------------------------------------------------------------------------------

const { runExact, ESEARCH_WINDOW } = await import('./pubmed-exact.mjs');
const { createHash } = await import('node:crypto');
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const sirve = (cuerpo, status = 200) => async (url, init = {}) => {
  entregadas.push({ url: String(url), method: init.method ?? 'GET', body: init.body?.toString() ?? '' });
  return { ok: status === 200, status, text: async () => cuerpo };
};
const recibo = async (cuerpo, term = 'consulta[tiab]', opciones = {}) => {
  entregadas.length = 0;
  return runExact(term, { fetcher: sirve(cuerpo), now: () => new Date(0), ...opciones });
};
const valoresDeEstado = router.provenance.operational_status?.values_by_dimension?.query_integrity ?? [];

// E1. Lo que se registra es lo que se envió y lo que llegó, no una reconstrucción.
const cuerpoValido = JSON.stringify(respuestas['consulta-valida'], null, 1);
const rv = await recibo(cuerpoValido, respuestas['consulta-valida'].term);
check('E1', rv.sent_query === respuestas['consulta-valida'].term
  && new URLSearchParams(entregadas[0].body).get('term') === rv.sent_query
  && rv.sent_query_sha256 === sha(rv.sent_query)
  && rv.transport === 'POST'
  && rv.raw_response_sha256 === sha(cuerpoValido)
  && rv.querytranslation === respuestas['consulta-valida'].esearchresult.querytranslation
  && rv.count_raw === '67408' && rv.result_count === 67408,
  'el recibo guarda la consulta enviada (y su hash), el transporte, el hash del cuerpo crudo y el diagnóstico tal como llegó');

// E2. La integridad se deriva de la respuesta, con un valor para cada cosa distinta.
const integridad = {};
for (const k of ['consulta-valida', 'cero-legitimo', 'mesh-inexistente', 'termino-descartado-con-resultados',
  'aviso-perdido-por-rettype-count']) {
  integridad[k] = (await recibo(JSON.stringify(respuestas[k]), respuestas[k].term)).status.query_integrity;
}
const integridadEsperada = {
  'consulta-valida': 'verified',
  'cero-legitimo': 'verified',
  'mesh-inexistente': 'failed',
  'termino-descartado-con-resultados': 'failed',
  'aviso-perdido-por-rettype-count': 'unsupported',
};
const integridadMal = Object.keys(integridadEsperada).filter((k) => integridad[k] !== integridadEsperada[k]);
const fueraDelContrato = Object.values(integridad).filter((v) => !valoresDeEstado.includes(v));
check('E2', integridadMal.length === 0 && fueraDelContrato.length === 0,
  `integridad: verificada y limpia, verificada y rota, y no verificable no se confunden${
    integridadMal.length ? ` — mal: ${JSON.stringify(integridadMal)}` : ''}${
    fueraDelContrato.length ? ` — valores fuera de operational_status: ${JSON.stringify(fueraDelContrato)}` : ''}`);

// E3. Un recuento inservible es null en el recibo, nunca un cero plausible (el `parseInt(...) || 0`).
const malos3 = [];
for (const raw of [{ querytranslation: 'x' }, { count: '12abc', querytranslation: 'x' }, { count: '', querytranslation: 'x' }]) {
  const r = await recibo(JSON.stringify({ esearchresult: raw }));
  if (r.result_count !== null || r.status.query_integrity === 'verified') malos3.push(raw);
}
check('E3', malos3.length === 0,
  `recuento ausente o malformado: ${malos3.length === 0 ? 'result_count null y no verificado' : JSON.stringify(malos3)}`);

// E4. Recuperar menos registros de los que hay se dice, y la ventana de ESearch también.
const parcial = await recibo(JSON.stringify({ esearchresult: {
  count: '12000', retmax: '2', idlist: ['1', '2'], querytranslation: 'x[tiab]' } }), 'x[tiab]', { retmax: 2 });
// La frontera es la que PubMed declara en su propio ERROR (medido el 2026-10-08): 9.999 registros.
// Historia: se fijó en 9.999 por un conector, se subió a 10.000 por la documentación de NCBI y la
// medición directa la devolvió a 9.999. retmax=9999 se envía; 10000 no.
let ventanaRechazada = false;
try { await recibo('{}', 'x[tiab]', { retmax: ESEARCH_WINDOW + 1 }); } catch { ventanaRechazada = entregadas.length === 0; }
await recibo(JSON.stringify({ esearchresult: { count: '0', querytranslation: 'x[tiab]' } }), 'x[tiab]',
  { retmax: ESEARCH_WINDOW });
const fronteraEnviada = entregadas.length === 1
  && new URLSearchParams(entregadas[0].body).get('retmax') === String(ESEARCH_WINDOW);
check('E4', parcial.records_retrieved === 2 && parcial.records_complete === false
  && typeof parcial.window_limit === 'string' && parcial.window_limit.startsWith('De 12000 registros')
  && parcial.result_count === 12000 && ventanaRechazada && fronteraEnviada && ESEARCH_WINDOW === 9999,
  'result_count y records_retrieved no se confunden, la ventana se declara bien, retmax=9999 se envía y 10000 no');

// E5. Un 414 no produce recibo con recuento: el ejecutor lanza fallo de transporte.
let e5;
try { e5 = await runExact('x[tiab]', { fetcher: sirve('', 414) }); } catch (e) { e5 = e; }
check('E5', e5 instanceof TransportError, 'el ejecutor convierte un 414 en fallo de transporte, nunca en un recibo');

// E6. El ejecutor ve la etiqueta que PubMed calla, y el «&amp;» que deja un saneador HTML. Reales.
const e6campo = await recibo(JSON.stringify(respuestas['campo-invalido']), respuestas['campo-invalido'].term);
const e6amp = await recibo(JSON.stringify(respuestas['amp-como-entidad']), respuestas['amp-como-entidad'].term);
check('E6', e6campo.status.query_integrity === 'failed' && e6campo.result_count === 246024
  && e6amp.status.query_integrity === 'failed',
  'etiqueta inexistente y «&amp;» saneado acaban en failed, con su recuento intacto');

// E7. El ERROR de ventana de PubMed no es JSON válido (salto de línea crudo). Respuesta real: el
// ejecutor lanza con el mensaje de PubMed, nunca devuelve un recibo con recuento.
let e7;
try { e7 = await recibo(respuestas['ventana-superada']._raw); } catch (e) { e7 = e; }
check('E7', e7 instanceof Error && /RESPUESTA_ILEGIBLE/.test(e7.message) && /9,999/.test(e7.message),
  'el ERROR ilegible de PubMed (retstart fuera de ventana) acaba en error explícito, no en un cero');

// E8. Un defecto conocido refuta la integridad aunque falte querytranslation: un descarte o un ERROR
// sin traducción es `failed`, no `unsupported`. Y la falta de diagnóstico sin anomalía sigue siendo
// `unsupported`, nunca `verified`. La primera versión miraba antes `verifiable` (Codex, 2026-10-08).
const e8 = {
  descarteSinTraduccion: await recibo(JSON.stringify({ esearchresult: { count: '1',
    warninglist: { quotedphrasesnotfound: ['"inventado"[tiab]'] } } }), '"inventado"[tiab]'),
  errorSinTraduccion: await recibo(JSON.stringify({ esearchresult: { count: '0', ERROR: 'database failure' } })),
  etiquetaSinTraduccion: await recibo(JSON.stringify({ esearchresult: { count: '5' } }), 'asthma [tiabb]'),
  ciegoLimpio: await recibo(JSON.stringify({ esearchresult: { count: '5' } }), 'asthma[tiab]'),
};
check('E8', e8.descarteSinTraduccion.status.query_integrity === 'failed'
  && e8.errorSinTraduccion.status.query_integrity === 'failed'
  && e8.etiquetaSinTraduccion.status.query_integrity === 'failed'
  && e8.ciegoLimpio.status.query_integrity === 'unsupported',
  `un defecto conocido es failed aunque falte el diagnóstico; sin anomalía y sin diagnóstico, unsupported: ${
    JSON.stringify(Object.fromEntries(Object.entries(e8).map(([k, v]) => [k, v.status.query_integrity])))}`);

// E9. El hash de la lista de PMIDs se comprueba contra uno calculado aparte, con varios PMIDs y en el
// orden en que llegan: un hash fijo (`sha256('')`) pasaba las dos suites (Codex, 2026-10-08).
const idsEnOrden = ['41626901', '36321557', '20734512'];
const e9 = await recibo(JSON.stringify({ esearchresult: { count: '3', idlist: idsEnOrden,
  querytranslation: 'x[tiab]' } }), 'x[tiab]', { retmax: 3 });
check('E9', e9.pmid_list_sha256 === createHash('sha256').update('41626901\n36321557\n20734512', 'utf8').digest('hex')
  && e9.pmids.join() === idsEnOrden.join() && e9.records_complete === true,
  'el hash de PMIDs es el de la lista recibida, en su orden, comprobado contra un cálculo independiente');

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
