/**
 * Implementación de referencia del contrato de lectura de un filtro.
 *
 * Es la única forma correcta de sacar la consulta de un `.txt` de este repositorio. Cualquier
 * superficie puede reimplementarla en su lenguaje, pero entonces debe pasar la misma suite
 * (`scripts/validate-router.mjs`), porque las dos maneras de equivocarse están medidas y
 * ninguna de las dos hace ruido:
 *
 *  - Tomar también lo posterior al marcador mete el JSON de metadatos en la consulta. PubMed
 *    devuelve `count: 0` con `quotedphrasesnotfound` vacío y el error escondido en
 *    `errorlist.phrasesnotfound`. Un cero falso.
 *  - Tomar solo la primera línea no comentada trunca los filtros multilínea y devuelve un número
 *    plausible: `ai_especifico` pierde registros y su restricción temporal sin avisar.
 *
 * El corte es por LÍNEA EXACTA igual al marcador, no por subcadena: el marcador se menciona dentro
 * de comentarios en la plantilla del repositorio, y cortar por subcadena trunca ahí.
 */

export const MARKER = '@@@FILTER_METADATA@@@';

/** Devuelve la consulta ejecutable de un fichero de filtro. */
export function parseFilter(text) {
  const lines = String(text).split(/\r?\n/);
  const end = lines.findIndex((line) => line.trim() === MARKER);
  const body = end === -1 ? lines : lines.slice(0, end);
  return body
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .map((line) => line.trim())
    .join(' ');
}

/** Devuelve el bloque de validación, o null si el fichero no lo trae. */
export function parseMetadata(text) {
  const lines = String(text).split(/\r?\n/);
  const end = lines.findIndex((line) => line.trim() === MARKER);
  if (end === -1) return null;
  const raw = lines.slice(end + 1).join('\n').trim();
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Una consulta que empieza por NOT es una cláusula de exclusión y se añade SIN `AND`.
 * `(tema) AND (NOT X)` se traduce en PubMed como `(tema) AND X`: devuelve justo lo que se
 * quería excluir, con un recuento plausible.
 */
export function isNegation(query) {
  return /^NOT\b/i.test(String(query).trim());
}

/** Compone tema y filtro respetando la naturaleza del filtro. */
export function compose(topic, filterQuery) {
  const q = String(filterQuery).trim();
  return isNegation(q) ? `(${topic}) ${q}` : `(${topic}) AND (${q})`;
}

/** Recorte temporal escondido dentro de la propia cadena del filtro. */
export function hasEmbeddedDateLimit(query) {
  return /("last\s+\d+\s+years"|\[dp\]|\[pdat\]|\[edat\]|\[dcom\]|\[crdt\])/i.test(String(query));
}

/**
 * Juicio de una respuesta de ESearch antes de usar su recuento.
 *
 * PubMed ya dice lo que ha descartado; el fallo no es que no avise, es que nadie lo mira. Un
 * encabezado MeSH inventado por un modelo es médicamente plausible y sintácticamente válido, así
 * que no produce ningún error: PubMed lo tira y lo apunta en `warninglist.quotedphrasesnotfound`.
 * Medido el 16/09/2026 con `"Atherosclerotic Cardiovascular Disease"[Mesh]`, que no existe y cuyo
 * descriptor oficial es `Atherosclerosis`.
 *
 * Y un detalle que vuelve el fallo verdaderamente invisible: pedida con `rettype=count`, la misma
 * consulta devuelve el mismo 0 **sin ninguna warninglist**. Por eso esta función distingue
 * «verificado y limpio» de «no verificable»: no son lo mismo y no deben informarse igual.
 *
 * Con `{ sentQuery }` mira además lo que la respuesta NO dice: etiquetas de campo ignoradas y
 * asteriscos falsos. Medido el 2026-10-08: `asthma[foo]` devuelve 246.024 registros,
 * `errorlist.fieldsnotfound` VACÍO y ningún aviso. Sin la consulta enviada no se da por comprobado.
 *
 * Lo que esta función NO puede saber: de dónde viene el objeto. Una respuesta de ESearch impecable
 * tampoco trae warninglist (no hay nada que avisar), así que un adaptador que recorte los avisos y deje
 * la traducción es indistinguible de PubMed limpio. La procedencia la garantiza quien llama: el
 * ejecutor de referencia habla con ESearch directamente.
 *
 * Devuelve { usable, verifiable, countIsValid, fieldTagsChecked, dropped, unknownTags, tagIssues,
 * lookalikes, pagination, anomalies, problems }.
 */
export function inspectResponse(esearchresult, { sentQuery } = {}) {
  const r = esearchresult ?? {};
  const rawCount = r.count;
  const count = Number(rawCount);
  // Un recuento ausente, vacío o no numérico no es un recuento. Sin esta puerta la función
  // devolvía `usable: true` para {querytranslation: '...'} sin count, para count: 'invalid',
  // vacío y null: daba luz verde justo a lo que existe para vigilar. Lo encontró una revisión
  // externa leyendo el código, no la suite.
  //
  // Y la puerta es la cadena, no `Number()`: `Number` acepta '0x10' (16), '1e3' (1000), '12.0', '+5'
  // y '-0'. ESearch envía dígitos decimales y nada más; cualquier otra forma no es su recuento.
  // Entre paréntesis a propósito: sin ellos, `x || cond ? a : b` se lee `(x || cond) ? a : b`, y la
  // mutación M3 (`true || ...`) dejaba de anular la puerta. Lo cazó la propia puerta de mutación.
  const countIsValid = (typeof rawCount === 'string'
    ? /^[0-9]+$/.test(rawCount)
    : typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount >= 0
      && !Object.is(rawCount, -0));
  const warn = r.warninglist;
  const err = r.errorlist ?? {};
  const problems = [];
  const fatal = r.ERROR;

  if (!countIsValid) {
    problems.push(`RECUENTO_INVALIDO: la respuesta no trae un recuento utilizable `
      + `(${JSON.stringify(rawCount)}). No se puede informar de cuántos registros hay.`);
  }

  if (fatal !== undefined && String(fatal).trim() !== '') {
    problems.push(`ERROR_FATAL: ${String(fatal).trim()}`);
  }

  const dropped = [
    ...(err.phrasesnotfound ?? []),
    ...(warn?.quotedphrasesnotfound ?? []),
    ...(warn?.phrasesignored ?? []),
  ];

  // El discriminador NO es la presencia de `warninglist`: una consulta impecable tampoco la trae,
  // porque no hay nada que avisar. Lo que distingue una respuesta diagnosticable de una ciega es
  // `querytranslation`, que viene siempre salvo cuando se pidió con `rettype=count`. Medido sobre
  // respuestas reales: la misma consulta rota devuelve el mismo 0 con y sin avisos según cómo se pida.
  const verifiable = typeof r.querytranslation === 'string' && r.querytranslation.length > 0;

  if (!verifiable) {
    problems.push('NO_VERIFICABLE: la respuesta no trae querytranslation, así que no se puede saber '
      + 'qué ejecutó PubMed ni qué descartó. Con rettype=count omite el diagnóstico: repite la '
      + 'consulta con retmax=0 antes de fiarte del recuento.');
  }
  if (dropped.length > 0) {
    problems.push(`TERMINOS_DESCARTADOS: PubMed ignoró ${JSON.stringify(dropped)}. `
      + 'No presentes en la búsqueda que de verdad se ejecutó.');
  }
  const hasErrorList = Object.values(err).some((value) => Array.isArray(value)
    ? value.length > 0
    : value !== null && value !== undefined && String(value).trim() !== '');
  if (hasErrorList) {
    problems.push(`ERRORLIST: ${JSON.stringify(err)}`);
  }
  // «Restrictions achieved. start and count adjusted to …» es PubMed recortando la PÁGINA pedida a
  // su ventana de 9.999 registros: dice cuántos PMIDs vienen, no qué se buscó. Se informa aparte, como
  // paginación; la integridad de la consulta no depende de ello. Medido el 2026-10-08.
  const outputmessages = warn?.outputmessages ?? [];
  const pagination = outputmessages.filter((m) => /^Restrictions achieved\b/i.test(m));
  const messages = outputmessages
    .filter((m) => !/^No items found\.?$/i.test(m) && !pagination.includes(m));
  if (messages.length > 0) problems.push(`AVISO_SEMANTICO: ${JSON.stringify(messages)}`);

  // Lo que solo se ve en la consulta enviada. Sin ella, NO se da por comprobado: la primera versión
  // devolvía `usable: true` si no se pasaba `sentQuery`, y `asthma[foo]` salía limpio (Codex, 2026-10-08).
  const fieldTagsChecked = typeof sentQuery === 'string';
  const tagIssues = fieldTagsChecked ? fieldTagIssues(sentQuery) : [];
  const unknownTags = tagIssues.map((x) => x.tag);
  const lookalikes = fieldTagsChecked ? lookalikeCharacters(sentQuery) : [];
  if (!fieldTagsChecked) {
    problems.push('ETIQUETAS_NO_COMPROBADAS: falta la consulta enviada (sentQuery). Una etiqueta de '
      + 'campo inexistente no produce ningún aviso de PubMed, así que sin ella no se puede dar por buena.');
  }
  if (tagIssues.length > 0) {
    problems.push(`ETIQUETA_IGNORADA: ${JSON.stringify(tagIssues)}. PubMed no avisa: tira la etiqueta o `
      + 'el modificador y aplica Automatic Term Mapping, así que el término no se buscó donde se pidió.');
  }
  if (lookalikes.length > 0) {
    problems.push(`TRUNCAMIENTO_FALSO: ${JSON.stringify(lookalikes)}. Parece un asterisco pero no lo es: `
      + 'PubMed lo descarta sin avisar y busca la raíz exacta (`intervent∗[ti]` = 9 registros; '
      + '`intervent*[ti]` = 269.566, medido el 2026-10-08).');
  }

  if (count === 0 && dropped.length > 0) {
    problems.push('CERO_ROTO: cero resultados con términos descartados. Es una consulta rota, '
      + 'no un campo vacío.');
  }

  // Dos clases de problema que no significan lo mismo: una ANOMALÍA es un defecto conocido (la consulta
  // no se ejecutó como se escribió); la FALTA de diagnóstico es no poder saberlo. Una anomalía basta
  // para refutar la integridad aunque falte querytranslation; la falta nunca basta para verificarla.
  const anomalies = problems.filter((p) => !/^(NO_VERIFICABLE|ETIQUETAS_NO_COMPROBADAS):/.test(p));

  return {
    usable: verifiable && countIsValid && fieldTagsChecked && problems.length === 0,
    verifiable,
    countIsValid,
    fieldTagsChecked,
    dropped,
    unknownTags,
    tagIssues,
    lookalikes,
    pagination,
    anomalies,
    problems,
  };
}

/**
 * Caracteres que parecen sintaxis de PubMed y no lo son. Llegan al copiar estrategias de un PDF: el
 * asterisco matemático `∗` (U+2217) de las tipografías científicas. Medido el 2026-10-08 en
 * `filters/methodology/horizon.txt`, que lo trae en seis términos copiados del artículo.
 */
const LOOKALIKES = { '∗': 'U+2217 (asterisco matemático)', '＊': 'U+FF0A (asterisco de ancho completo)',
  '⁎': 'U+204E (asterisco bajo)', '✱': 'U+2731 (asterisco grueso)', '﹡': 'U+FE61 (asterisco pequeño)' };

/** Términos de una consulta con un carácter que imita la sintaxis de PubMed, fuera de comillas. */
export function lookalikeCharacters(query) {
  const found = [];
  // También dentro de comillas: la primera versión las vaciaba antes de mirar, y
  // `"randomized trial∗"[tiab]` (65.068, sin truncar) salía verified frente a los 109.950 de
  // `"randomized trial*"[tiab]` (Codex, segunda ronda, 2026-10-08).
  for (const m of String(query).matchAll(/[^\s()|]*[∗＊⁎✱﹡][^\s()|]*/g)) {
    const ch = [...m[0]].find((c) => c in LOOKALIKES);
    const entry = `${m[0]} (${LOOKALIKES[ch]})`;
    if (!found.includes(entry)) found.push(entry);
  }
  return found;
}

/**
 * Etiquetas de campo de PubMed, en minúsculas y sin modificadores. Verificadas una a una contra
 * E-utilities el 2026-10-08, cada una con un término que existe en su campo: con la etiqueta, la
 * traducción nombra el campo; con una que no existe (`[foo]`, `[tiabb]`, `[author identifier]`),
 * PubMed la tira en silencio y aplica Automatic Term Mapping. La lista puede quedarse corta —una
 * etiqueta legítima que falte sale como problema y se ve—, que es el lado seguro.
 */
export const PUBMED_FIELD_TAGS = new Set([
  'ad', 'affiliation', 'aid', 'all', 'all fields', 'au', 'author', '1au', 'author - first', 'lastau',
  'author - last', 'fau', 'full author name', 'auid', 'book', 'cn',
  'corporate author', 'author - corporate', 'cois', 'conflict of interest statements', 'crdt',
  'date - create', 'dcom', 'date - completion', 'dp', 'pdat', 'date - publication',
  'publication date', 'edat', 'date - entry', 'epdat', 'electronic publication date', 'ppdat',
  'print publication date', 'ed', 'editor', 'filter', 'sb', 'subset', 'fir', 'ir', 'investigator',
  'full investigator name', 'gr', 'grants and funding', 'ip', 'issue', 'is', 'issn', 'jid', 'jo',
  'jour', 'journal', 'ta', 'so', 'la', 'lang', 'language', 'lid', 'location id', 'lr',
  'date - modification', 'majr', 'mesh major topic', 'mh', 'mesh', 'mesh terms', 'mhda',
  'date - mesh', 'nm', 'supplementary concept', 'substance name', 'ot', 'other term', 'pa',
  'pharmacological action', 'pg', 'pagination', 'pl', 'place of publication', 'pmid', 'uid', 'ps',
  'subject - personal name', 'pt', 'publication type', 'pubn', 'publisher', 'rn', 'si',
  'secondary source id', 'sh', 'mesh subheading', 'subheading', 'ti', 'title', 'tiab',
  'title/abstract', 'tt', 'transliterated title', 'tw', 'text word', 'vi', 'volume',
]);

/**
 * Campos que admiten cada modificador. Fuera de ellos PubMed lo tira SIN AVISAR, medido el 2026-10-08:
 * `asthma[mh:~3]` se busca como MeSH normal, `"asthma control"[tw:~2]` como Text Word sin proximidad y
 * `asthma[ti:noexp]` como Title. La proximidad solo existe en título, título/resumen y afiliación.
 */
const NOEXP_TAGS = new Set(['mh', 'mesh', 'mesh terms', 'majr', 'mesh major topic', 'sh', 'mesh subheading',
  'subheading', 'pt', 'publication type']);
const PROXIMITY_TAGS = new Set(['ti', 'title', 'tiab', 'title/abstract', 'ad', 'affiliation']);

const OPEN_QUOTES = new Set(['"', '“']);
const CLOSE_QUOTES = new Set(['"', '”']);
const TERM_END = /[\p{L}\p{N}"”'’*)∗＊⁎✱﹡]/u;
const WORD = /[\p{L}\p{N}]/u;

/**
 * Problemas de las etiquetas de campo de una consulta. PubMed no avisa de NINGUNO. Devuelve
 * [{ tag, reason }], con reason:
 *   'desconocida'  la etiqueta no existe;
 *   'modificador'  `:noexp` o `:~N` en un campo que no lo admite;
 *   'grupo'        etiqueta sobre un grupo con operadores: `(asthma OR copd)[tiab]` se busca en todos
 *                  los campos, no en título/resumen (351.416 frente a 257.958, medido el 2026-10-08).
 *                  Un paréntesis sin operadores es parte del término: `Front Endocrinol (Lausanne)[JO]`;
 *   'posicion'     etiqueta detrás de un operador, o sin término al que aplicarse;
 *   'proximidad'   `:~N` que no va sobre una frase entrecomillada de dos o más palabras sin comodines.
 *                  PubMed la tira sin avisar (2026-10-08): `"asthma* control"[tiab:~2]` = 10.391, sin
 *                  proximidad (Codex, segunda ronda); `asthma control[tiab:~2]` sin comillas, igual.
 *
 * Recorre la consulta en vez de usar una expresión regular, porque lo que decide es el contexto. La
 * primera versión era una regex con lookbehind y una revisión externa (Codex, 2026-10-08) la tumbó:
 *  - PubMed aplica la etiqueta aunque haya espacios delante (`asthma [tiab]` = `asthma[tiab]`), así que
 *    `asthma [tiabb]` es una etiqueta muerta; la regex exigía el corchete pegado y daba `verified`;
 *  - dentro de comillas un corchete es texto: `"[18F]FDG"[tiab]` es una búsqueda válida y la regex lo
 *    marcaba como etiqueta `[18F]`;
 *  - un corchete que empieza un término y va pegado a lo que sigue (`[18F]FDG`) no es etiqueta.
 */
export function fieldTagIssues(query) {
  const q = String(query);
  const issues = [];
  const add = (tag, reason) => {
    if (!issues.some((x) => x.tag === tag && x.reason === reason)) issues.push({ tag, reason });
  };
  let inQuote = false;
  for (let i = 0; i < q.length; i += 1) {
    const c = q[i];
    if (inQuote) {
      if (CLOSE_QUOTES.has(c)) inQuote = false;
      continue;
    }
    if (OPEN_QUOTES.has(c)) { inQuote = true; continue; }
    if (c !== '[') continue;

    const close = q.indexOf(']', i + 1);
    if (close === -1) break; // corchete sin cerrar: lo vigila la sintaxis (R14), no esto
    const raw = q.slice(i, close + 1);
    let j = i - 1;
    while (j >= 0 && /\s/.test(q[j])) j -= 1;
    const prev = j >= 0 ? q[j] : '';
    const next = q[close + 1] ?? '';

    if (!TERM_END.test(prev)) {
      // Nada a lo que aplicarse. Pegado a lo que sigue, empieza un término (`[18F]FDG`); si no, es una
      // etiqueta suelta.
      if (!WORD.test(next)) add(raw, 'posicion');
      i = close;
      continue;
    }
    if (/(^|[\s()])(AND|OR|NOT)$/.test(q.slice(0, j + 1))) {
      add(raw, 'posicion');
      i = close;
      continue;
    }

    const inner = q.slice(i + 1, close).trim().toLowerCase().replace(/\s+/g, ' ');
    const [, base, modifier] = /^(.*?)(?::\s*(noexp|~\s*\d+))?$/.exec(inner);
    const field = base.trim();
    if (!PUBMED_FIELD_TAGS.has(field)) add(raw, 'desconocida');
    else if (modifier === 'noexp' && !NOEXP_TAGS.has(field)) add(raw, 'modificador');
    else if (modifier && modifier !== 'noexp' && !PROXIMITY_TAGS.has(field)) add(raw, 'modificador');
    else if (modifier && modifier !== 'noexp' && !proximityPhraseOk(q, j)) add(raw, 'proximidad');

    if (prev === ')' && groupHasOperator(q, j)) add(`(…)${raw}`, 'grupo');
    i = close;
  }
  return issues;
}

/**
 * ¿Lo que precede a una etiqueta con `:~N` es una frase válida para proximidad? Tiene que ser una frase
 * entrecomillada, de dos o más palabras y sin comodines (ni asteriscos tipográficos): la ayuda de
 * PubMed no admite truncamiento dentro de una búsqueda por proximidad.
 */
function proximityPhraseOk(q, end) {
  if (!CLOSE_QUOTES.has(q[end])) return false;
  let k = end - 1;
  while (k >= 0 && !OPEN_QUOTES.has(q[k])) k -= 1;
  if (k < 0) return false;
  const phrase = q.slice(k + 1, end).trim();
  return phrase.split(/\s+/).length >= 2 && !/[*∗＊⁎✱﹡]/.test(phrase);
}

/** ¿El grupo que cierra el paréntesis en la posición `end` contiene un operador booleano? */
function groupHasOperator(q, end) {
  let depth = 0;
  let inQuote = false;
  for (let k = end; k >= 0; k -= 1) {
    const c = q[k];
    if (inQuote) {
      if (OPEN_QUOTES.has(c)) inQuote = false;
      continue;
    }
    if (CLOSE_QUOTES.has(c)) { inQuote = true; continue; }
    if (c === ')') depth += 1;
    else if (c === '(') {
      depth -= 1;
      if (depth === 0) {
        const inside = q.slice(k + 1, end).replace(/["“][^"”]*["”]/g, '""');
        return /\b(AND|OR|NOT)\b|\|/.test(inside);
      }
    }
  }
  return false;
}

/** Las etiquetas con problema, como cadenas. */
export function unknownFieldTags(query) {
  return fieldTagIssues(query).map((x) => x.tag);
}
