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
 * Devuelve { usable, verifiable, dropped, problems }.
 */
export function inspectResponse(esearchresult) {
  const r = esearchresult ?? {};
  const count = Number(r.count ?? NaN);
  const warn = r.warninglist;
  const err = r.errorlist ?? {};
  const problems = [];

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
  if (Object.keys(err).some((k) => Array.isArray(err[k]) && err[k].length > 0)) {
    problems.push(`ERRORLIST: ${JSON.stringify(err)}`);
  }
  const messages = (warn?.outputmessages ?? []).filter((m) => !/^No items found\.?$/i.test(m));
  if (messages.length > 0) problems.push(`AVISO_SEMANTICO: ${JSON.stringify(messages)}`);

  if (count === 0 && dropped.length > 0) {
    problems.push('CERO_ROTO: cero resultados con términos descartados. Es una consulta rota, '
      + 'no un campo vacío.');
  }

  return {
    usable: verifiable && dropped.length === 0 && problems.length === 0,
    verifiable,
    dropped,
    problems,
  };
}
