/**
 * Analizador XML mínimo y estricto para las respuestas de EFetch (especificación 29-, §3.2).
 *
 * POR QUÉ NO OTRO. El ejecutor corre también en Cloudflare Workers, que no tiene DOMParser, y el
 * repositorio no tiene dependencias. Con expresiones regulares no se analiza bien una estructura
 * anidada: un `<PMID>` de una referencia citada se confunde con el del artículo. Esto recorre el texto
 * carácter a carácter y devuelve un árbol, o lanza `XmlError`: nunca un árbol parcial.
 *
 * QUÉ NO HACE, a propósito. No carga DTD ni entidades externas: reconoce el DOCTYPE de PubMed sin
 * desreferenciarlo, rechaza un subconjunto interno (podría declarar entidades) y solo admite las cinco
 * entidades predefinidas y las referencias numéricas. Una entidad desconocida es un error, no un hueco.
 * Descarta comentarios e instrucciones de proceso, que no son contenido. No valida contra el DTD.
 *
 * Árbol: un elemento es `{ name, attrs, children }`, con `attrs` sin prototipo y `children` mezclando
 * elementos y cadenas de texto. Los saltos CRLF y CR llegan como LF (XML 1.0, §2.11).
 */

export class XmlError extends Error {
  constructor(message, at) {
    super(`XML_INVALIDO: ${message}${at === undefined ? '' : ` (posición ${at})`}`);
    this.at = at;
  }
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const SPACE = /[ \t\n]*/y;
const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export const MAX_DEPTH = 256;

/** Decodifica las referencias de un tramo de texto o de un valor de atributo. */
function decode(raw, at) {
  if (!raw.includes('&')) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp === -1) { out += raw.slice(i); break; }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(';', amp);
    if (semi === -1) throw new XmlError('referencia sin «;»', at + amp);
    const ref = raw.slice(amp + 1, semi);
    if (ref.startsWith('#')) {
      const code = /^#x[0-9A-Fa-f]{1,6}$/.test(ref) ? parseInt(ref.slice(2), 16)
        : /^#[0-9]{1,7}$/.test(ref) ? parseInt(ref.slice(1), 10) : NaN;
      // Un carácter que XML no admite (nulo, sustitutos, fuera de Unicode) no se convierte en otro.
      if (!(code === 0x9 || code === 0xA || code === 0xD || (code >= 0x20 && code <= 0xD7FF)
        || (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF))) {
        throw new XmlError(`referencia numérica no válida «&${ref};»`, at + amp);
      }
      out += String.fromCodePoint(code);
    } else if (Object.hasOwn(PREDEFINED, ref)) {
      out += PREDEFINED[ref];
    } else {
      throw new XmlError(`entidad no definida «&${ref};»: no se cargan DTD ni entidades externas`, at + amp);
    }
    i = semi + 1;
  }
  return out;
}

/**
 * Analiza un documento completo. Devuelve `{ doctype, root }`; `doctype` es `{ name, publicId,
 * systemId }` o null. Lanza XmlError ante cualquier defecto de forma.
 */
export function parseXml(input) {
  if (typeof input !== 'string') throw new XmlError('la entrada no es texto');
  const s = input.replace(/\r\n?/g, '\n');
  let i = 0;
  let doctype = null;
  let root = null;
  const stack = [];

  const name = () => {
    NAME.lastIndex = i;
    const m = NAME.exec(s);
    if (!m) throw new XmlError('se esperaba un nombre', i);
    i += m[0].length;
    return m[0];
  };
  const space = () => { SPACE.lastIndex = i; i += SPACE.exec(s)[0].length; };
  const expect = (lit) => {
    if (!s.startsWith(lit, i)) throw new XmlError(`se esperaba «${lit}»`, i);
    i += lit.length;
  };
  const until = (lit, what) => {
    const end = s.indexOf(lit, i);
    if (end === -1) throw new XmlError(`${what} sin cerrar`, i);
    const body = s.slice(i, end);
    i = end + lit.length;
    return body;
  };
  const quoted = () => {
    const q = s[i];
    if (q !== '"' && q !== "'") throw new XmlError('valor sin comillas', i);
    const start = ++i;
    const end = s.indexOf(q, i);
    if (end === -1) throw new XmlError('valor sin cerrar', start);
    i = end + 1;
    return { raw: s.slice(start, end), at: start };
  };
  const comment = () => {
    const body = until('-->', 'comentario');
    if (body.includes('--')) throw new XmlError('«--» dentro de un comentario', i);
  };
  const pi = () => {
    const target = name();
    if (target.toLowerCase() === 'xml') throw new XmlError('declaración XML fuera del principio', i);
    until('?>', 'instrucción de proceso');
  };
  const doctypeDecl = () => {
    expect('<!DOCTYPE');
    if (!/[ \t\n]/.test(s[i] ?? '')) throw new XmlError('DOCTYPE mal formado', i);
    space();
    const dt = { name: name(), publicId: null, systemId: null };
    space();
    if (s.startsWith('PUBLIC', i)) {
      i += 6; space(); dt.publicId = quoted().raw; space(); dt.systemId = quoted().raw; space();
    } else if (s.startsWith('SYSTEM', i)) {
      i += 6; space(); dt.systemId = quoted().raw; space();
    }
    if (s[i] === '[') throw new XmlError('DOCTYPE con subconjunto interno: podría declarar entidades y no se admite', i);
    expect('>');
    return dt;
  };
  /** Comentarios, instrucciones de proceso y espacio, fuera del elemento raíz. */
  const misc = () => {
    for (;;) {
      space();
      if (s.startsWith('<!--', i)) { i += 4; comment(); } else if (s.startsWith('<?', i)) { i += 2; pi(); } else return;
    }
  };

  if (s.startsWith('<?xml', i) && /[ \t\n?]/.test(s[i + 5] ?? '')) until('?>', 'declaración XML');
  misc();
  if (s.startsWith('<!DOCTYPE', i)) { doctype = doctypeDecl(); misc(); }
  if (s[i] !== '<') throw new XmlError('falta el elemento raíz', i);

  const text = (parent, raw, at) => {
    if (raw.includes(']]>')) throw new XmlError('«]]>» en el texto', at);
    const value = decode(raw, at);
    if (value === '') return;
    const last = parent.children.length - 1;
    // Texto contiguo (p. ej. texto + CDATA) en un solo nodo: dos lecturas del mismo XML dan el mismo árbol.
    if (last >= 0 && typeof parent.children[last] === 'string') parent.children[last] += value;
    else parent.children.push(value);
  };

  // Elemento raíz y contenido, con una pila en vez de recursión: la profundidad la decide el documento.
  for (;;) {
    if (i >= s.length) throw new XmlError(stack.length ? `fin del documento con <${stack.at(-1).name}> abierto` : 'documento vacío', i);
    const top = stack.at(-1);
    if (s[i] !== '<') {
      if (!top) throw new XmlError('texto fuera del elemento raíz', i);
      const end = s.indexOf('<', i);
      const raw = s.slice(i, end === -1 ? s.length : end);
      text(top, raw, i);
      i += raw.length;
      continue;
    }
    if (s.startsWith('<!--', i)) { if (!top) throw new XmlError('comentario antes de la raíz', i); i += 4; comment(); continue; }
    if (s.startsWith('<![CDATA[', i)) {
      if (!top) throw new XmlError('CDATA fuera del elemento raíz', i);
      i += 9;
      const body = until(']]>', 'CDATA');
      const last = top.children.length - 1;
      if (body !== '') {
        if (last >= 0 && typeof top.children[last] === 'string') top.children[last] += body;
        else top.children.push(body);
      }
      continue;
    }
    if (s.startsWith('<?', i)) { if (!top) throw new XmlError('instrucción antes de la raíz', i); i += 2; pi(); continue; }
    if (s.startsWith('<!', i)) throw new XmlError('declaración no admitida dentro del documento', i);
    if (s.startsWith('</', i)) {
      i += 2;
      const closing = name();
      space();
      expect('>');
      if (!top || top.name !== closing) throw new XmlError(`cierre </${closing}> sin apertura que le corresponda`, i);
      stack.pop();
      if (stack.length === 0) break;
      continue;
    }
    if (!top && root) throw new XmlError('más de un elemento raíz', i);
    i += 1;
    const el = { name: name(), attrs: Object.create(null), children: [] };
    for (;;) {
      const before = i;
      space();
      if (s.startsWith('/>', i) || s[i] === '>') break;
      if (i === before) throw new XmlError('falta espacio entre atributos', i);
      const attr = name();
      space(); expect('='); space();
      const { raw, at } = quoted();
      if (raw.includes('<')) throw new XmlError('«<» en un valor de atributo', at);
      if (Object.hasOwn(el.attrs, attr)) throw new XmlError(`atributo repetido «${attr}»`, at);
      // Normalización de atributos de XML: el espacio literal pasa a espacio; una referencia (&#10;) se respeta.
      el.attrs[attr] = decode(raw.replace(/[\t\n]/g, ' '), at);
    }
    if (top) top.children.push(el); else root = el;
    if (s.startsWith('/>', i)) {
      i += 2;
      if (!top) break;
    } else {
      i += 1;
      stack.push(el);
      if (stack.length > MAX_DEPTH) throw new XmlError(`más de ${MAX_DEPTH} niveles de anidamiento`, i);
    }
  }
  misc();
  if (i !== s.length) throw new XmlError('contenido después del elemento raíz', i);
  return { doctype, root };
}

/** Hijos elemento con ese nombre, en orden. */
export const childrenNamed = (el, name) => (el?.children ?? []).filter((c) => typeof c !== 'string' && c.name === name);
/** El único hijo con ese nombre, null si no hay; lanza si hay más de uno (no se elige uno). */
export function childNamed(el, name) {
  const found = childrenNamed(el, name);
  if (found.length > 1) throw new XmlError(`<${name}> repetido dentro de <${el.name}>`);
  return found[0] ?? null;
}
