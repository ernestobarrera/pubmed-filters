/**
 * Representación canónica `pubmed-abstract-v1` de un abstract de PubMed (especificación 29-, §3.5).
 *
 * Una sola definición para quien la produce (`fetch-core.mjs`, al leer el XML) y quien la comprueba
 * (`dossier-check.mjs`, al recibir los archivos): dos normalizadores distintos acabarían dando por
 * íntegro lo que el otro no reconoce. Es código puro, sin red ni disco.
 *
 * La forma: un array de bloques (el `Abstract` principal y cada `OtherAbstract`, en orden), cada uno con
 * las claves `kind`, `language`, `type`, `sections`, `copyright`, en ese orden; cada sección con `label`,
 * `nlm_category`, `text`. Sin claves omitidas: lo ausente es null. La cadena es el JSON compacto de
 * `JSON.stringify`, y la huella se calcula sobre sus bytes UTF-8. «Íntegro» se refiere a ESTA
 * representación, no a una identidad de bytes con el XML de NCBI.
 */

export const ABSTRACT_FORMAT = 'pubmed-abstract-v1';
export const BLOCK_KEYS = ['kind', 'language', 'type', 'sections', 'copyright'];
export const SECTION_KEYS = ['label', 'nlm_category', 'text'];
export const BLOCK_KINDS = ['abstract', 'other_abstract'];

export const utf8Length = (text) => new TextEncoder().encode(text).length;

/** La cadena canónica de unos bloques: orden de claves fijo y null en lo ausente. */
export function canonicalAbstract(blocks) {
  return JSON.stringify(blocks.map((b) => ({
    kind: b.kind,
    language: b.language ?? null,
    type: b.type ?? null,
    sections: b.sections.map((s) => ({ label: s.label ?? null, nlm_category: s.nlm_category ?? null, text: s.text })),
    copyright: b.copyright ?? null,
  })));
}

/** ¿Hay algún carácter distinto de espacio en alguna sección? Si no, el registro es `without_abstract`. */
export const hasAbstractText = (blocks) => blocks.some((b) => b.sections.some((s) => /\S/.test(s.text)));

const sameKeys = (obj, keys) => {
  const own = Object.keys(obj);
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
};
const strOrNull = (v) => v === null || typeof v === 'string';

/**
 * Comprueba una cadena recibida como abstract canónico: JSON válido, esquema exacto (claves y su orden,
 * tipos, secciones no vacías, un solo `abstract` y delante), forma canónica (al re-serializarla salen los
 * mismos caracteres) y algún texto. Devuelve `{ ok, problems, blocks }`. La longitud y la huella se
 * comprueban aparte, sobre la cadena tal como llegó.
 */
export function checkCanonicalAbstract(canonical) {
  const problems = [];
  if (typeof canonical !== 'string') return { ok: false, problems: ['abstract_canonical no es una cadena'], blocks: null };
  let blocks;
  try {
    blocks = JSON.parse(canonical);
  } catch {
    return { ok: false, problems: ['abstract_canonical no es JSON válido: cadena incompleta o alterada'], blocks: null };
  }
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { ok: false, problems: ['abstract_canonical no es una lista no vacía de bloques'], blocks: null };
  }
  blocks.forEach((b, i) => {
    const at = `bloque ${i}`;
    if (b === null || typeof b !== 'object' || Array.isArray(b) || !sameKeys(b, BLOCK_KEYS)) {
      problems.push(`${at}: claves distintas de ${BLOCK_KEYS.join(', ')} o en otro orden`);
      return;
    }
    if (!BLOCK_KINDS.includes(b.kind)) problems.push(`${at}: kind «${b.kind}» no admitido`);
    if (b.kind === 'abstract' && i !== 0) problems.push(`${at}: el abstract principal va primero y una sola vez`);
    if (!strOrNull(b.language) || !strOrNull(b.type) || !strOrNull(b.copyright)) problems.push(`${at}: language, type y copyright son cadena o null`);
    if (!Array.isArray(b.sections) || b.sections.length === 0) {
      problems.push(`${at}: sections debe ser una lista no vacía`);
      return;
    }
    b.sections.forEach((s, j) => {
      if (s === null || typeof s !== 'object' || Array.isArray(s) || !sameKeys(s, SECTION_KEYS)) {
        problems.push(`${at}, sección ${j}: claves distintas de ${SECTION_KEYS.join(', ')} o en otro orden`);
      } else if (!strOrNull(s.label) || !strOrNull(s.nlm_category) || typeof s.text !== 'string') {
        problems.push(`${at}, sección ${j}: label y nlm_category son cadena o null; text, cadena`);
      }
    });
  });
  if (problems.length === 0 && JSON.stringify(blocks) !== canonical) {
    problems.push('abstract_canonical no está en forma canónica (espacios, escapes o claves repetidas)');
  }
  if (problems.length === 0 && !hasAbstractText(blocks)) problems.push('abstract_canonical no tiene texto: no es un abstract obtenido');
  return { ok: problems.length === 0, problems, blocks: problems.length === 0 ? blocks : null };
}
