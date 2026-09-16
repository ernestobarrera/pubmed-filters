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
