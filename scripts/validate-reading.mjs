#!/usr/bin/env node
/**
 * Pruebas de la lectura con recibo (`pubmed_fetch_exact`) y del comprobador de dossier
 * (`scripts/dossier-check.mjs`): las de §5 de la especificación 29-, con la adenda de Codex del 24/10.
 *
 * Uso:  node scripts/validate-reading.mjs        Sale 0 si todo pasa.
 *
 * Sin red. NCBI se sustituye por respuestas servidas como `Response` de verdad (con su flujo de bytes),
 * para que el límite de tamaño, el corte y el tiempo se prueben sobre la lectura real. Los registros son
 * SINTÉTICOS, con la estructura de PubMed (DOCTYPE, MedlineCitation, CommentsCorrections, ReferenceList…):
 * el repositorio no versiona texto de abstracts reales. El 24/10/2026 se pasó además el núcleo por los 27
 * registros reales de la batería con red (paso7-, fuera del repositorio): 27 con abstract, 2,35-4,73 KB
 * por registro y la peor tanda de cinco en 20,6 KB.
 *
 * Lo que NO prueban: que una superficie concreta conserve estas salidas al exportarlas, ni que ChatGPT
 * deje retirar el otro conector. Eso es la prueba de superficie de §5, que va aparte y con OK.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './exact-core.mjs';
import { parseXml, XmlError } from './xml-lite.mjs';
import { EFETCH_URL } from './efetch.mjs';
import { ABSTRACT_FORMAT, canonicalAbstract, checkCanonicalAbstract, utf8Length } from './abstract-canonical.mjs';
import { runFetch, fetchRequestError, sha256Bytes, MAX_STRUCTURED_BYTES, FETCH_RECEIPT_TYPE } from './fetch-core.mjs';
import { checkDossier, extractCandidates } from './dossier-check.mjs';
import { createMcpHandler } from '../mcp/protocol.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pass = [];
const fail = [];
const check = (id, ok, detail) => (ok ? pass : fail).push(`${id}  ${detail}`);
const enc = (s) => new TextEncoder().encode(s);
const bytesOf = (o) => utf8Length(JSON.stringify(o));
const CTX = { plan_ref: 'plan-1/r1', read_id: 'l1' };

// --- Registros sintéticos con la forma de PubMed -----------------------------------------------------

const DOCTYPE = '<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">';
const xmlSet = (...items) => `<?xml version="1.0" ?>\n${DOCTYPE}\n<PubmedArticleSet>\n${items.join('\n')}\n</PubmedArticleSet>\n`;
const sections = (list) => list.map((s) => `<AbstractText${s.label ? ` Label="${s.label}"` : ''}${s.cat ? ` NlmCategory="${s.cat}"` : ''}>${s.text}</AbstractText>`).join('');
function article({ pmid, title = `Synthetic trial ${pmid}.`, abstract = [{ label: 'BACKGROUND', cat: 'BACKGROUND', text: `Background of ${pmid}.` },
  { label: 'RESULTS', cat: 'RESULTS', text: `Result of ${pmid}: 59% vs 82% (P &lt; 0.01).` }], rawAbstract, other = [],
  doi = `10.5555/synthetic.${pmid}`, pubDate = '<Year>2020</Year><Month>Jan</Month><Day>05</Day>', types = ['Journal Article'], pmc = null }) {
  const abs = rawAbstract ?? (abstract ? `<Abstract>${sections(abstract)}</Abstract>` : '');
  return `<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">${pmid}</PMID>`
    + '<DateCompleted><Year>1999</Year><Month>01</Month><Day>01</Day></DateCompleted><DateRevised><Year>2024</Year><Month>02</Month><Day>02</Day></DateRevised>'
    + `<Article PubModel="Print"><Journal><ISSN IssnType="Print">0000-0000</ISSN><JournalIssue CitedMedium="Print"><Volume>1</Volume><PubDate>${pubDate}</PubDate></JournalIssue>`
    + `<Title>Synthetic Journal</Title></Journal><ArticleTitle>${title}</ArticleTitle><Pagination><MedlinePgn>1-9</MedlinePgn></Pagination>`
    + `<ELocationID EIdType="doi" ValidYN="Y">${doi}</ELocationID>${abs}<Language>eng</Language>`
    + `<PublicationTypeList>${types.map((t) => `<PublicationType UI="D016428">${t}</PublicationType>`).join('')}</PublicationTypeList></Article>`
    + '<CommentsCorrectionsList><CommentsCorrections RefType="CommentIn"><RefSource>Synthetic</RefSource><PMID Version="1">99999999</PMID></CommentsCorrections></CommentsCorrectionsList>'
    + other.map((o) => `<OtherAbstract Type="${o.type}" Language="${o.lang}">${sections(o.sections)}</OtherAbstract>`).join('')
    + `</MedlineCitation><PubmedData><History><PubMedPubDate PubStatus="pubmed"><Year>2020</Year></PubMedPubDate></History><ArticleIdList>`
    + `<ArticleId IdType="pubmed">${pmid}</ArticleId><ArticleId IdType="doi">${doi}</ArticleId>${pmc ? `<ArticleId IdType="pmc">${pmc}</ArticleId>` : ''}</ArticleIdList>`
    + '<ReferenceList><Reference><Citation>Synthetic reference.</Citation><ArticleIdList><ArticleId IdType="doi">10.9999/ref</ArticleId>'
    + '<ArticleId IdType="pubmed">88888888</ArticleId></ArticleIdList></Reference></ReferenceList></PubmedData></PubmedArticle>';
}
const book = (pmid) => `<PubmedBookArticle><BookDocument><PMID Version="1">${pmid}</PMID><ArticleIdList><ArticleId IdType="bookaccession">NBK1</ArticleId></ArticleIdList>`
  + '<Book><Publisher><PublisherName>Synthetic Press</PublisherName></Publisher><BookTitle book="x">Synthetic Book</BookTitle><PubDate><Year>2019</Year></PubDate></Book>'
  + `<ArticleTitle>Chapter ${pmid}</ArticleTitle><Abstract><AbstractText>Book chapter abstract.</AbstractText></Abstract><PublicationType UI="D016454">Review</PublicationType></BookDocument>`
  + `<PubmedBookData><ArticleIdList><ArticleId IdType="pubmed">${pmid}</ArticleId></ArticleIdList></PubmedBookData></PubmedBookArticle>`;

/** NCBI de prueba: sirve `body` (texto, bytes, función de la petición o flujo) y anota cada petición entregada. */
const sent = [];
const ncbi = (body, status = 200) => async (url, init = {}) => {
  sent.push({ url: String(url), method: init.method, body: init.body?.toString() ?? '' });
  const ids = new URLSearchParams(init.body?.toString() ?? '').get('id')?.split(',') ?? [];
  const value = typeof body === 'function' ? body(ids, init) : body;
  return value instanceof Response ? value : new Response(value, { status });
};
const byIds = (make) => ncbi((ids) => xmlSet(...ids.map((p) => make(p))));
const fetchWith = (pmids, fetcher, extra = {}) => runFetch(pmids, CTX, { fetcher, ...extra });
const resultOf = (receipt, pmid) => receipt.results.find((r) => r.requested_pmid === pmid);
const blocksOf = (r) => JSON.parse(r.abstract_canonical);

// --- F1. Entrada: rechazada antes de NCBI ------------------------------------------------------------

sent.length = 0;
const malas = {
  cero: [[], CTX], seis: [['1', '2', '3', '4', '5', '6'], CTX], repetido: [['12', '12'], CTX], numero: [[12], CTX],
  ceroIzquierda: [['0123'], CTX], espacio: [[' 123'], CTX], nulo: [[null], CTX], listaNula: [null, CTX],
  sinContexto: [['1'], undefined], contextoNulo: [['1'], null], claveAjena: [['1'], { ...CTX, text_offset: 0 }],
  sinReadId: [['1'], { plan_ref: 'p' }], readIdLargo: [['1'], { plan_ref: 'p', read_id: 'x'.repeat(41) }], planVacio: [['1'], { plan_ref: '  ', read_id: 'r' }],
};
const rechazadas = await Promise.all(Object.entries(malas).map(async ([k, [p, c]]) => {
  const error = fetchRequestError(p, c);
  let threw = false;
  try { await runFetch(p, c, { fetcher: ncbi(xmlSet()) }); } catch { threw = true; }
  return [k, error !== null && threw];
}));
check('F1', rechazadas.every(([, ok]) => ok) && sent.length === 0 && fetchRequestError(['1', '123456789'], CTX) === null,
  `entrada: cero o seis PMID, repetidos, números, ceros a la izquierda, espacios, null, contexto ausente, claves ajenas (continuación) o largas se rechazan antes de NCBI${
    rechazadas.some(([, ok]) => !ok) ? ` — mal: ${rechazadas.filter(([, ok]) => !ok).map(([k]) => k).join(', ')}` : ''}`);

// --- F2. Transporte: una petición EFetch, POST, lista exacta; la clave viaja y no aparece -------------

sent.length = 0;
const conClave = await fetchWith(['3', '1', '2'], byIds((p) => article({ pmid: p })), { apiKey: 'CLAVE-SECRETA', email: 'contacto@ejemplo.invalid', tool: 'herramienta' });
const cuerpo = new URLSearchParams(sent[0]?.body ?? '');
check('F2', sent.length === 1 && sent[0].method === 'POST' && sent[0].url === EFETCH_URL && !new URL(sent[0].url).search
  && cuerpo.get('db') === 'pubmed' && cuerpo.get('retmode') === 'xml' && cuerpo.get('id') === '3,1,2' && cuerpo.get('api_key') === 'CLAVE-SECRETA'
  && cuerpo.get('email') === 'contacto@ejemplo.invalid' && cuerpo.get('tool') === 'herramienta' && [...cuerpo.keys()].length === 6
  && !JSON.stringify(conClave).includes('CLAVE-SECRETA') && !JSON.stringify(conClave).includes('contacto@ejemplo.invalid')
  && conClave.request.api_key_used === true && conClave.request.email_used === true && conClave.transport.method === 'POST'
  && conClave.transport.raw_response_sha256 === createHash('sha256').update(xmlSet(article({ pmid: '3' }), article({ pmid: '1' }), article({ pmid: '2' }))).digest('hex'),
  'una sola petición EFetch por POST con db, retmode y la lista exacta en el cuerpo; clave y contacto viajan a NCBI y no al recibo; huella del cuerpo recibido');

// --- F3. Identidad y estados: por PMID, nunca por posición; un error nunca es una ausencia ------------

const desordenado = await fetchWith(['10', '20', '30'], ncbi(xmlSet(article({ pmid: '30' }), article({ pmid: '10' }), article({ pmid: '20' }))));
const faltante = await fetchWith(['10', '20'], ncbi(xmlSet(article({ pmid: '20' }))));
const mixto = await fetchWith(['10', '20'], ncbi(xmlSet(article({ pmid: '10' }), article({ pmid: '20', abstract: null }))));
const e500 = await fetchWith(['10', '20'], ncbi('fallo', 500));
const e429 = await fetchWith(['10'], ncbi('{"error":"API rate limit exceeded"}', 429));
const duplicado = await fetchWith(['10', '20'], ncbi(xmlSet(article({ pmid: '10' }), article({ pmid: '10' }), article({ pmid: '20' }))));
const inesperado = await fetchWith(['10'], ncbi(xmlSet(article({ pmid: '10' }), article({ pmid: '77' }))));
const libro = await fetchWith(['40'], ncbi(xmlSet(book('40'))));
const desconocido = await fetchWith(['10', '20'], ncbi(xmlSet(article({ pmid: '10' }), '<PubmedFutureArticle><PMID>20</PMID></PubmedFutureArticle>')));
const desconocidoSinPmid = await fetchWith(['10', '20'], ncbi(xmlSet(article({ pmid: '10' }), '<PubmedFutureArticle><X/></PubmedFutureArticle>')));
const raizRara = await fetchWith(['10'], ncbi('<?xml version="1.0" ?><eFetchResult><ERROR>Empty id list</ERROR></eFetchResult>'));
const sinPmid = await fetchWith(['10'], ncbi(xmlSet('<PubmedArticle><MedlineCitation><Article/></MedlineCitation></PubmedArticle>')));
const titulos = ['10', '20', '30'].map((p) => resultOf(desordenado, p)?.title);
const fallidos = [e500, e429, duplicado, inesperado, raizRara, sinPmid];
check('F3', desordenado.results.map((r) => r.requested_pmid).join() === '10,20,30' && titulos.join('|') === 'Synthetic trial 10.|Synthetic trial 20.|Synthetic trial 30.'
  && desordenado.status.record_identity === 'verified' && desordenado.status.delivery === 'complete'
  && resultOf(faltante, '10').record_status === 'not_found' && faltante.status.delivery === 'complete' && /pídelos solos/.test(faltante.problems.join(' '))
  && resultOf(mixto, '10').record_status === 'with_abstract' && resultOf(mixto, '20').record_status === 'without_abstract' && resultOf(mixto, '20').abstract_sha256 === null
  && fallidos.every((r) => r.status.delivery === 'failed' && r.status.record_identity === 'failed' && r.pending_pmids.length === 0
    && r.results.every((x) => x.record_status === 'error' && x.reason) && !r.results.some((x) => x.record_status === 'not_found'))
  && e429.results[0].reason === 'http_status' && e429.transport.http_status === 429 && duplicado.results[0].reason === 'identity_uncertain'
  && raizRara.failure.code === 'unexpected_root'
  && resultOf(libro, '40').record_status === 'with_abstract' && resultOf(libro, '40').record_type === 'PubmedBookArticle' && resultOf(libro, '40').publication_types.join() === 'Review'
  && desconocido.status.record_identity === 'unsupported' && resultOf(desconocido, '20').reason === 'unsupported_record' && resultOf(desconocido, '10').record_status === 'with_abstract'
  && desconocidoSinPmid.status.record_identity === 'unsupported' && resultOf(desconocidoSinPmid, '20').reason === 'identity_uncertain'
  && resultOf(desordenado, '10').dois.join() === '10.5555/synthetic.10',
  'orden cambiado, PMID faltante (no encontrado en ESTA respuesta), lote mixto, error global y 429, PMID duplicado o no pedido, libro, formato desconocido con y sin PMID: asociación por PMID y ningún error convertido en ausencia');

// --- F4. Secciones, marcado y XML: nada se pierde en silencio -------------------------------------------

const estructurado = await fetchWith(['50'], ncbi(xmlSet(article({ pmid: '50',
  title: 'Effect of CO<sub>2</sub> on m<sup>2</sup> &amp; <i>H. pylori</i>.',
  abstract: [{ label: 'METHODS', cat: 'METHODS', text: 'Line one\r\nline two\rline three.' },
    { label: 'RESULTS', cat: 'RESULTS', text: 'First <b>result</b> 1.73 m<sup>2</sup>; HbA<sub>1c</sub> &lt; 7%.' },
    { label: 'RESULTS', cat: 'RESULTS', text: 'Second <u>result</u> with Unicode: España, ó &#xf3; &#243; 🔬.' }],
  other: [{ type: 'Publisher', lang: 'spa', sections: [{ text: 'Resumen en espa&#xf1;ol.' }] }],
  pmc: 'PMC123' }))));
const e = resultOf(estructurado, '50');
const eb = e.record_status === 'with_abstract' ? blocksOf(e) : [];
const libre = resultOf(await fetchWith(['51'], ncbi(xmlSet(article({ pmid: '51', abstract: [{ text: 'Unstructured text.' }] })))), '51');
const conCopyright = resultOf(await fetchWith(['52'], ncbi(xmlSet(article({ pmid: '52',
  rawAbstract: '<Abstract><AbstractText>Text.</AbstractText><CopyrightInformation>&#xa9; 2020 Synthetic.</CopyrightInformation></Abstract>' })))), '52');
const formula = resultOf(await fetchWith(['53'], ncbi(xmlSet(article({ pmid: '53',
  abstract: [{ text: 'Equation <mml:math><mml:mi>x</mml:mi></mml:math> holds.' }] })))), '53');
const formulaTitulo = resultOf(await fetchWith(['54'], ncbi(xmlSet(article({ pmid: '54', title: 'A <mml:math><mml:mi>x</mml:mi></mml:math> title.' })))), '54');
const blanco = resultOf(await fetchWith(['55'], ncbi(xmlSet(article({ pmid: '55', abstract: [{ text: '  \n\t ' }] })))), '55');
const cdata = resultOf(await fetchWith(['56'], ncbi(xmlSet(article({ pmid: '56', abstract: [{ text: 'A <![CDATA[<raw> & text]]> end.' }] })))), '56');
const xmlMalos = {
  entidadDesconocida: xmlSet(article({ pmid: '57', abstract: [{ text: 'Bad &nbsp; entity.' }] })),
  subconjuntoInterno: '<?xml version="1.0"?><!DOCTYPE PubmedArticleSet [<!ELEMENT PubmedArticleSet ANY>]><PubmedArticleSet></PubmedArticleSet>',
  cruzado: xmlSet('<PubmedArticle><MedlineCitation><PMID>57</PMID></PubmedArticle></MedlineCitation>'),
  cortado: xmlSet(article({ pmid: '57' })).slice(0, 900),
  dosRaices: `${xmlSet()}<PubmedArticleSet></PubmedArticleSet>`,
  atributoRepetido: xmlSet('<PubmedArticle a="1" a="2"></PubmedArticle>'),
};
const fallosXml = await Promise.all(Object.entries(xmlMalos).map(async ([k, x]) => [k, (await fetchWith(['57'], ncbi(x))).failure?.code]));
const utf8Roto = await fetchWith(['58'], ncbi(new Uint8Array([...enc(xmlSet()).slice(0, 60), 0xff, 0xfe, ...enc(xmlSet()).slice(60)])));
const bom = await fetchWith(['59'], ncbi(new Uint8Array([0xef, 0xbb, 0xbf, ...enc(xmlSet(article({ pmid: '59' })))])));
check('F4', e.record_status === 'with_abstract' && e.abstract_format === ABSTRACT_FORMAT && eb.length === 2
  && e.title === 'Effect of CO_(2) on m^(2) & H. pylori.'
  && eb[0].kind === 'abstract' && eb[0].language === null && eb[0].sections.map((s) => s.label).join() === 'METHODS,RESULTS,RESULTS'
  && eb[0].sections[0].text === 'Line one\nline two\nline three.'
  && eb[0].sections[1].text === 'First result 1.73 m^(2); HbA_(1c) < 7%.'
  && eb[0].sections[2].text === 'Second result with Unicode: España, ó ó ó 🔬.'
  && eb[1].kind === 'other_abstract' && eb[1].language === 'spa' && eb[1].type === 'Publisher' && eb[1].sections[0].text === 'Resumen en español.' && eb[1].sections[0].label === null
  && e.abstract_canonical === canonicalAbstract(eb) && checkCanonicalAbstract(e.abstract_canonical).ok
  && e.abstract_bytes === utf8Length(e.abstract_canonical) && e.abstract_sha256 === createHash('sha256').update(e.abstract_canonical, 'utf8').digest('hex')
  && e.pmcids.join() === 'PMC123' && e.year === 2020 && e.publication_date.source === 'MedlineCitation/Article/Journal/JournalIssue/PubDate'
  && blocksOf(libre)[0].sections[0].label === null && blocksOf(libre)[0].sections[0].nlm_category === null
  && blocksOf(conCopyright)[0].copyright === '© 2020 Synthetic.'
  && formula.record_status === 'error' && formula.reason === 'unsupported_abstract_content' && formula.abstract_canonical === undefined
  && formulaTitulo.record_status === 'error' && formulaTitulo.reason === 'unsupported_markup'
  && blanco.record_status === 'without_abstract' && blanco.abstract_sha256 === null
  && blocksOf(cdata)[0].sections[0].text === 'A <raw> & text end.'
  && fallosXml.every(([, code]) => code === 'invalid_xml') && utf8Roto.failure?.code === 'invalid_encoding'
  && resultOf(bom, '59').record_status === 'with_abstract',
  `secciones en orden con RESULTS repetido, OtherAbstract aparte con idioma y tipo, entidades, CRLF, Unicode sin normalizar, ^() y _(), CDATA, copyright; fórmula = error, solo espacios = sin abstract; XML roto (${fallosXml.map(([k, c]) => `${k}:${c}`).join(', ')}) y UTF-8 inválido = fallo declarado`);

// Fechas: año del número, nunca de creación o revisión; una fecha textual ambigua conserva el texto.
const fecha = async (pd) => resultOf(await fetchWith(['60'], ncbi(xmlSet(article({ pmid: '60', pubDate: pd })))), '60');
const fechas = { medline: await fecha('<MedlineDate>2003 Jul-Aug</MedlineDate>'), ambigua: await fecha('<MedlineDate>1998 Dec-1999 Jan</MedlineDate>'),
  estacion: await fecha('<Year>2001</Year><Season>Spring</Season>'), sinFecha: await fecha('') };
check('F5', fechas.medline.year === 2003 && fechas.medline.publication_date.medline_date === '2003 Jul-Aug'
  && fechas.ambigua.year === null && fechas.ambigua.publication_date.medline_date === '1998 Dec-1999 Jan'
  && fechas.estacion.year === 2001 && fechas.estacion.publication_date.season === 'Spring'
  && fechas.sinFecha.year === null && fechas.sinFecha.publication_date.year === null && resultOf(desordenado, '10').year === 2020,
  'fecha de publicación con su origen: Year o una MedlineDate de un solo año; una ambigua conserva el texto con year null; nunca DateCompleted ni DateRevised');

// --- F6. Tamaño y entrega: registros atómicos, pendientes explícitos, nada cortado --------------------

const texto = (n, ch = 'a') => ch.repeat(n);
const grande = (p, n, ch) => article({ pmid: p, abstract: [{ label: 'RESULTS', cat: 'RESULTS', text: texto(n, ch) }] });
const cabe5 = await fetchWith(['1', '2', '3', '4', '5'], byIds((p) => grande(p, 3000)));
// 1 y 2 grandes (no caben juntos), 3 pequeño: el 2 queda pendiente y el 3 entra después de él.
const parcial = await fetchWith(['1', '2', '3'], byIds((p) => grande(p, p === '3' ? 200 : 13000)));
const solo = await fetchWith(['1', '2'], byIds((p) => grande(p, p === '1' ? 30000 : 200)));
// Comillas: 6.000 bytes en el XML, 24.000 en el recibo (se escapan dos veces); se mide DESPUÉS de escapar.
const escapes = await fetchWith(['1'], byIds((p) => grande(p, 6000, '&quot;')));
// Tres bytes por carácter: 9.000 caracteres caben contados como caracteres, no como bytes.
const multibyte = await fetchWith(['1'], byIds((p) => grande(p, 9000, '中')));
const recibos6 = [cabe5, parcial, solo, escapes, multibyte];
const verificaEntregados = (r) => r.results.filter((x) => x.record_status === 'with_abstract').every((x) => checkCanonicalAbstract(x.abstract_canonical).ok
  && createHash('sha256').update(x.abstract_canonical, 'utf8').digest('hex') === x.abstract_sha256 && x.abstract_bytes === utf8Length(x.abstract_canonical));
const tooLarge = (r, p) => resultOf(r, p)?.reason === 'record_too_large' && resultOf(r, p).record_bytes > MAX_STRUCTURED_BYTES - 3000
  && Number.isSafeInteger(resultOf(r, p).max_record_bytes) && resultOf(r, p).max_record_bytes < MAX_STRUCTURED_BYTES && resultOf(r, p).abstract_canonical === undefined;
check('F6', recibos6.every((r) => bytesOf(r) <= MAX_STRUCTURED_BYTES && verificaEntregados(r))
  && cabe5.status.delivery === 'complete' && cabe5.results.length === 5 && cabe5.pending_pmids.length === 0
  && parcial.status.delivery === 'partial' && parcial.results.map((x) => x.requested_pmid).join() === '1,3'
  && parcial.pending_pmids.map((x) => `${x.pmid}:${x.reason}`).join() === '2:response_size_limit'
  && solo.status.delivery === 'partial' && tooLarge(solo, '1') && resultOf(solo, '2').record_status === 'with_abstract' && solo.pending_pmids.length === 0
  && tooLarge(escapes, '1') && tooLarge(multibyte, '1') && utf8Length(texto(9000, '中')) > MAX_STRUCTURED_BYTES && 9000 < MAX_STRUCTURED_BYTES,
  `presupuesto de ${MAX_STRUCTURED_BYTES} bytes tras escapar: cinco que caben (${bytesOf(cabe5)} B) completos; parcial con pendiente intercalado en orden (${bytesOf(parcial)} B); `
  + 'el que no cabe solo es record_too_large con su tamaño, también por escapes o bytes multibyte; lo entregado verifica entero');

// Corte de red a mitad del cuerpo, cuerpo mayor que el límite y tiempo agotado: fallos, nunca un prefijo.
const flujo = (parts, { failAfter = null, hang = false } = {}) => new Response(new ReadableStream({
  async pull(ctrl) {
    if (parts.length) { ctrl.enqueue(enc(parts.shift())); return; }
    if (failAfter) { ctrl.error(new Error('conexión cortada')); return; }
    if (hang) await new Promise((r) => setTimeout(r, 10000));
    ctrl.close();
  },
}), { status: 200 });
const xmlEntero = xmlSet(article({ pmid: '1' }));
const corte = await fetchWith(['1'], ncbi(() => flujo([xmlEntero.slice(0, 500)], { failAfter: true })));
const enorme = await fetchWith(['1'], ncbi(() => flujo([xmlEntero, ' '.repeat(3000)])), { maxXmlBytes: 2000 });
const t0 = Date.now();
const lento = await fetchWith(['1'], ncbi(() => flujo([xmlEntero.slice(0, 500)], { hang: true })), { timeoutMs: 80 });
check('F7', corte.failure?.code === 'network' && corte.transport.raw_response_sha256 === null && corte.results[0].reason === 'network'
  && enorme.failure?.code === 'response_too_large' && enorme.transport.bytes_received > 2000 && enorme.transport.raw_response_sha256 === null
  && lento.failure?.code === 'timeout' && Date.now() - t0 < 5000
  && [corte, enorme, lento].every((r) => r.status.delivery === 'failed' && r.results.every((x) => x.record_status === 'error')),
  'corte de red a mitad del cuerpo, cuerpo mayor que el límite (medido al leer) y tiempo agotado durante la lectura: fallo explícito, sin huella ni registros');

// --- F8. El recibo: tipo, run, intento, contexto; la lectura no tiene query_integrity --------------------

const RUN = { contract_version: '1.14.0', repository_commit: 'c'.repeat(40) };
const conRun = await fetchWith(['10'], byIds((p) => article({ pmid: p })), { run: RUN });
const otroIntento = await fetchWith(['10'], byIds((p) => article({ pmid: p })), { run: RUN });
check('F8', conRun.receipt_type === FETCH_RECEIPT_TYPE && conRun.receipt_version === '1' && conRun.run === RUN
  && /^[0-9a-f-]{36}$/.test(conRun.attempt_id) && conRun.attempt_id !== otroIntento.attempt_id
  && conRun.request.context_sha256 === await sha256(JSON.stringify(CTX)) && conRun.request.declared_by === 'agent'
  && !('query_integrity' in conRun.status) && Object.keys(conRun.status).join() === 'record_identity,delivery'
  && Date.parse(conRun.received_at) <= Date.parse(conRun.executed_at) && Date.parse(conRun.executed_at) <= Date.parse(conRun.completed_at)
  && conRun.limits.max_pmids === 5 && conRun.limits.structured_content_max_bytes === MAX_STRUCTURED_BYTES
  && resultOf(conRun, '10').abstract_sha256 === resultOf(otroIntento, '10').abstract_sha256,
  'recibo: tipo y versión propios, el run del servidor tal cual, attempt_id por invocación, huella del contexto, tiempos ordenados; sin query_integrity');

// --- F9. XML: el analizador mínimo, contra sus casos de forma --------------------------------------------

const xmlOk = parseXml('<?xml version="1.0"?>\n<!-- c --><!DOCTYPE r SYSTEM "x.dtd"><r a="1 &amp; 2" b=\'&#10;\'><x/>t<![CDATA[]]><?pi y?></r>\n');
const xmlFallos = ['<r>', '<r></s>', '<r/><r/>', '<r/>texto', 'texto<r/>', '<r a=1/>', '<r a="<"/>', '<r>&amp</r>', '<r>&#0;</r>', '<r>]]></r>',
  '<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r>', '<r><!-- -- --></r>', `${'<a>'.repeat(300)}${'</a>'.repeat(300)}`]
  .filter((x) => { try { parseXml(x); return true; } catch (err) { return !(err instanceof XmlError); } });
check('F9', xmlOk.doctype?.systemId === 'x.dtd' && xmlOk.root.attrs.a === '1 & 2' && xmlOk.root.attrs.b === '\n'
  && xmlOk.root.children.length === 2 && xmlOk.root.children[1] === 't' && Object.getPrototypeOf(xmlOk.root.attrs) === null && xmlFallos.length === 0,
  `analizador XML: DOCTYPE reconocido sin cargarlo, entidades y atributos; sin cerrar, cruzado, dos raíces, texto fuera, entidad no definida, subconjunto interno o 300 niveles = XmlError${
    xmlFallos.length ? ` — aceptados: ${xmlFallos.join(' | ')}` : ''}`);

// --- F10-F12. Revisión de Codex del 25/10 (R6-R8): casos sintéticos de defensa del contrato, no respuestas
// observadas en NCBI real.

// F10 (R7). Caracteres fuera de XML en texto, CDATA, atributo o comentario, y declaraciones mal formadas o
// con otra codificación: XmlError. Las declaraciones válidas, también con comillas simples y standalone, pasan.
const r7Malos = { nulo: '<r>a\u0000b</r>', nuloEnCdata: '<r><![CDATA[a\u0001b]]></r>', nuloEnAtributo: '<r a="\u0002"/>', nuloEnComentario: '<r><!-- \u0003 --></r>',
  sustitutoSuelto: '<r>\ud800</r>', fffe: '<r>￾</r>', declaracionBasura: '<?xml nonsense?><r/>', declaracionSinVersion: '<?xml encoding="UTF-8"?><r/>',
  otraCodificacion: '<?xml version="1.0" encoding="ISO-8859-1"?><r/>' };
const r7Aceptados = Object.entries(r7Malos).filter(([, x]) => { try { parseXml(x); return true; } catch (err) { return !(err instanceof XmlError); } }).map(([k]) => k);
const r7Buenos = ['<?xml version="1.0" ?><r/>', "<?xml version='1.0' encoding='utf-8' standalone='yes'?><r/>", '<r>\t\n🔬</r>']
  .filter((x) => { try { parseXml(x); return false; } catch { return true; } });
const controlLiteral = await fetchWith(['11', '22'], ncbi(xmlSet(article({ pmid: '11', abstract: [{ text: 'a\u0000b' }] }))));
check('F10', r7Aceptados.length === 0 && r7Buenos.length === 0 && controlLiteral.failure?.code === 'invalid_xml'
  && controlLiteral.results.every((x) => x.record_status === 'error'),
  `caracteres no XML en texto, CDATA, atributo o comentario y declaraciones mal formadas o no UTF-8 se rechazan; las válidas pasan${
    r7Aceptados.length ? ` — aceptados: ${r7Aceptados.join(', ')}` : ''}${r7Buenos.length ? ` — rechazados por error: ${r7Buenos.length}` : ''}`);

// F11 (R6). Un <ERROR> de NCBI dentro del conjunto invalida la respuesta entera antes de atribuir registros o
// decidir ausencias, lleve o no un PMID dentro y venga o no con registros válidos.
const errorMixto = await fetchWith(['11', '22'], ncbi(xmlSet(article({ pmid: '11' }), '<ERROR>Provider failed</ERROR>')));
const errorConPmid = await fetchWith(['11', '22'], ncbi(xmlSet('<ERROR><PMID>11</PMID></ERROR>')));
check('F11', [errorMixto, errorConPmid].every((r) => r.failure?.code === 'ncbi_error' && r.status.delivery === 'failed'
  && r.status.record_identity === 'failed' && r.results.every((x) => x.record_status === 'error' && x.reason === 'ncbi_error'))
  && /Provider failed/.test(errorMixto.failure.message),
  'un <ERROR> dentro de PubmedArticleSet, con registros válidos o con un PMID dentro, es fallo de la llamada: ni registros ni ausencias certificados');

// F12 (R8). Lo que viene de la respuesta se acota en los diagnósticos: un nombre de 30.000 caracteres, una
// entidad o un <ERROR> enormes dan un recibo estructurado dentro del presupuesto, nunca una excepción.
const gigante = 'X'.repeat(30000);
const r8 = {
  nombre: await fetchWith(['11', '22'], ncbi(xmlSet(`<${gigante}/>`))),
  entidad: await fetchWith(['11'], ncbi(xmlSet(article({ pmid: '11', abstract: [{ text: `&${gigante};` }] })))),
  error: await fetchWith(['11'], ncbi(xmlSet(`<ERROR>${gigante}</ERROR>`))),
  marcado: await fetchWith(['11'], ncbi(xmlSet(article({ pmid: '11', abstract: [{ text: `<${gigante}/>` }] })))),
};
check('F12', Object.values(r8).every((r) => bytesOf(r) < 4000)
  && r8.nombre.status.record_identity === 'unsupported' && r8.nombre.results.every((x) => x.reason === 'identity_uncertain')
  && r8.entidad.failure?.code === 'invalid_xml' && r8.error.failure?.code === 'ncbi_error'
  && resultOf(r8.marcado, '11')?.reason === 'unsupported_abstract_content',
  `diagnósticos acotados: nombre, entidad, <ERROR> y marcado de 30.000 caracteres dan recibos estructurados de ${
    Object.values(r8).map(bytesOf).join(', ')} bytes`);

// --- X. dossier-check ---------------------------------------------------------------------------------
// Una excepción aquí (p. ej. porque una mutación rompió el transporte y un recibo no trae lo esperado) es
// un fallo declarado: no puede llevarse por delante el informe de las comprobaciones F, que ya corrieron.
try {
  let reloj = Date.parse('2026-10-24T10:00:00.000Z');
  const now = () => new Date(reloj += 1000);
  const salto = (ms) => { reloj += ms; };
  const queries = new Map();
  const esearchFake = (url, init) => {
    const p = new URLSearchParams(init.body.toString());
    const q = queries.get(p.get('term'));
    const start = Number(p.get('retstart') ?? 0);
    const n = Number(p.get('retmax') ?? 0);
    const idlist = q.status === 429 ? [] : q.ids.slice(start, start + n);
    if (q.status === 429) return { ok: false, status: 429, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ esearchresult: { count: String(q.count ?? q.ids.length), retmax: String(idlist.length),
      retstart: String(start), idlist, querytranslation: p.get('term'), ...(q.broken ? { warninglist: { phrasesignored: ['x'] } } : {}) } }) };
  };
  const records = new Map();
  const efetchFake = (url, init) => {
    const ids = new URLSearchParams(init.body.toString()).get('id').split(',');
    return new Response(xmlSet(...ids.filter((p) => records.get(p) !== null).map((p) => records.get(p) ?? article({ pmid: p }))));
  };
  const fetcher = async (url, init) => (String(url) === EFETCH_URL ? efetchFake(url, init) : esearchFake(url, init));
  const { buildFilterBundle } = await import('./filter-source.mjs');
  const bundle = await buildFilterBundle(ROOT);
  // Con clave, el espaciado entre llamadas a NCBI es de 110 ms en vez de 350: aquí no se prueba la cuota.
  const server = createMcpHandler({ fetcher, now, run: RUN, filters: bundle, engine: 'mcp/stdio.mjs', apiKey: 'clave-de-prueba' });
  let rpcId = 0;
  const call = async (name, args) => server({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  const registro = ({ plan = 'plan-1', pass: passId = 'p1', path, known } = {}) => ({ plan_ref: plan, facets: [{ facet: 'topic', role_in_question: 'core' }], filters: [],
    pass: { pass_id: passId, purpose: 'test pass', ...(path ? { reading_path: path } : {}) }, ...(known ? { known_pmids: known } : {}) });
  const buscar = (query, { retmax = 10, retstart = 0, ...rec } = {}) => call('pubmed_search_exact', { query, retmax, retstart, selection_record: registro(rec) });
  const leer = (pmids, readId = 'l1', plan = 'plan-1') => call('pubmed_fetch_exact', { pmids, context: { plan_ref: plan, read_id: readId } });

  /** Un dossier en memoria: archivos con su huella, manifiesto y cargador. */
  async function dossier({ attempts, response, citations, usage, reference, intersections, profile = 'bench', closure = false, clock = null, plans,
    inventoryBy = 'harness', tamper = {}, logExtra = [] }) {
    const store = new Map();
    const put = async (path, content) => {
      const bytes = content instanceof Uint8Array ? content : enc(typeof content === 'string' ? content : JSON.stringify(content));
      store.set(path, bytes);
      return { file: path, sha256: await sha256Bytes(bytes) };
    };
    const list = [];
    for (const [i, a] of attempts.entries()) {
      const ref = a.raw === undefined ? {} : await put(`intentos/${i}.json`, a.raw);
      list.push({ attempt_ref: a.ref ?? `a${i}`, tool: a.tool, external_id: a.ext === undefined ? `call-${i}` : a.ext,
        ...(a.raw === undefined ? { absent_reason: 'conexión cortada antes de la respuesta' } : { ...ref, captured: a.captured ?? 'on_receipt' }),
        ...(a.plan ? { plan_ref: a.plan } : {}), ...(a.pass ? { pass_id: a.pass } : {}), ...(a.walk ? { walk_id: a.walk } : {}), ...(a.request ? { request: a.request } : {}) });
    }
    const m = {
      format: 'pubmed-dossier-manifest', format_version: 1, dossier_id: 'D-1', case: 'S', condition: 'test', profile,
      capture: { method: 'harness_log', inventory_by: inventoryBy, closure: null, clock }, plans: plans ?? [{ plan_ref: 'plan-1', passes: ['p1', 'p2'] }],
      attempts: list, intersections: [],
    };
    if (closure) {
      m.capture.closure = await put('captura.json', { format: 'pubmed-dossier-capture-log', format_version: 1, dossier_id: 'D-1', closed: true,
        calls: [...list.map((a, i) => ({ external_id: a.external_id, tool: a.tool, sequence: i + 1 })), ...logExtra] });
    }
    let responseSha = null;
    if (response !== undefined) { m.response = { ...await put('respuesta.md', response), captured: 'on_receipt' }; responseSha = m.response.sha256; }
    const usesDoc = (u) => ({ format: 'pubmed-dossier-uses', format_version: 1, response_sha256: responseSha, ...u });
    if (citations) m.citations = await put('citas.json', usesDoc(citations));
    if (usage) m.usage_log = await put('usos.json', usesDoc(usage));
    if (reference) m.reference = { ...await put('referencia.json', reference.json), ...(reference.case_id ? { case_id: reference.case_id } : {}) };
    for (const [i, x] of (intersections ?? []).entries()) m.intersections.push({ ...await put(`interseccion-${i}.json`, x.raw), plan_ref: x.plan, pass_id: x.pass });
    for (const [path, fn] of Object.entries(tamper)) store.set(path, fn(store.get(path)));
    const result = await checkDossier(m, async (p) => store.get(p) ?? null);
    return { result, store, manifest: m };
  }
  const S = (r) => ({ tool: 'pubmed_search_exact', raw: r });
  const F = (r) => ({ tool: 'pubmed_fetch_exact', raw: r });
  const codes = (res) => res.defects.map((d) => d.code);
  const prov = (res, pmid) => res.provenance.find((p) => p.pmid === pmid);
  const stage = (res, name) => res.retention.stages?.find((s) => s.stage === name);
  const CLOCK = { skew_bound_ms: 2000, justification: 'prueba sintética: un solo proceso y un solo reloj' };

  // X1. El ejemplo de cómputo fijado en 29-, §4.5, con un 429 de más.
  queries.clear(); records.clear();
  queries.set('topic-1[tiab]', { ids: ['11', '22'], count: 80 });
  queries.set('topic-2[tiab]', { ids: ['22', '44'], count: 90 });
  queries.set('topic-1[tiab] retry', { ids: [], status: 429 });
  records.set('44', article({ pmid: '44', abstract: null }));
  const x1p1 = await buscar('topic-1[tiab]', { known: [{ pmid: '33', origin: 'user', detail: 'given by the user' }] });
  const x1p2 = await buscar('topic-2[tiab]', { pass: 'p2' });
  const x1e = await buscar('topic-1[tiab] retry');
  salto(10000);
  const x1f = await leer(['11', '22', '33', '44']);
  // El hueco de 22: la exportación conservó solo la primera mitad de su abstract.
  const x1fHueco = structuredClone(x1f);
  const r22 = x1fHueco.result.structuredContent.results.find((r) => r.requested_pmid === '22');
  r22.abstract_canonical = r22.abstract_canonical.slice(0, Math.floor(r22.abstract_canonical.length / 2));
  x1fHueco.result.content[0].text = JSON.stringify(x1fHueco.result.structuredContent);
  const respuesta1 = 'Según el ensayo (PMID 33) y la guía nacional de 2024, el rescate funciona.';
  const x1 = await dossier({
    attempts: [S(x1p1), S(x1p2), { ...S(x1e), plan: 'plan-1', pass: 'p1' }, F(x1fHueco)], closure: true, clock: CLOCK, response: respuesta1,
    usage: { declared_by: 'agent', uses: [{ source: { type: 'pmid', value: '33' }, fragment: 'PMID 33', start: respuesta1.indexOf('PMID 33'), end: respuesta1.indexOf('PMID 33') + 7 },
      { source: { type: 'url', value: 'https://guia.example/2024' }, fragment: 'la guía nacional de 2024' }] },
    reference: { json: { format: 'pubmed-dossier-reference', format_version: 1, reference_id: 'R-sintetica', version: '1', source: 'ejemplo 29-', partial: false,
      target_pmids: ['11', '22', '33'], synthesis_pmids: [] } },
  });
  const r1 = x1.result;
  const d1 = Object.fromEntries(r1.denominators.D1.per_pass.map((p) => [p.pass_id, p.value]));
  check('X1', d1.p1 === 80 && d1.p2 === 90 && !('total' in r1.denominators.D1)
    && r1.denominators.D2.value === 3 && r1.denominators.D2.raw_appearances === 4 && r1.denominators.D2.overlap.join() === '22'
    && r1.denominators.D3.value === 2 && r1.denominators.D3.requested_unique === 4 && r1.denominators.D3.obtained.join() === '11,33'
    && r1.denominators.D3.abstract_gap.join() === '22' && r1.denominators.D3.without_abstract.join() === '44'
    && r1.denominators.D4.value === 2 && r1.denominators.D4.pmid_sources === 1 && r1.denominators.D4.other_sources === 1
    && prov(r1, '33').membership === 'known_only' && prov(r1, '33').temporality === 'declared_before_fetch'
    && ['11', '22', '44'].every((p) => prov(r1, p).membership === 'returned')
    && stage(r1, 'returned').ratio === 2 / 3 && stage(r1, 'abstracts_preserved').ratio === 2 / 3 && stage(r1, 'documented_use').ratio === 1 / 3
    && r1.retention.within_query.status === 'not_measured'
    && r1.verdict === 'incomplete' && codes(r1).includes('abstract_gap') && r1.exit_code === 1,
    `ejemplo fijado de 29-: D1 80 y 90 sin total, D2 3 (4 brutos), D3 2 de 4, D4 2 (1 PMID), 33 known_only declarado antes, retenciones 2/3, 2/3 y 1/3, y el hueco de 22 da incomplete — veredicto ${r1.verdict}`);

  // X2. Cambios: abstract alterado, cortado, con longitud falsa o no canónico; repetición y dos versiones.
  queries.clear(); records.clear();
  queries.set('t[tiab]', { ids: ['101'] });
  const x2s = await buscar('t[tiab]');
  const x2f = await leer(['101'], 'l1');
  const variar = (fn) => { const c = structuredClone(x2f); fn(c.result.structuredContent.results[0]); c.result.content[0].text = JSON.stringify(c.result.structuredContent); return c; };
  const alterados = {
    huella: variar((r) => { r.abstract_sha256 = 'f'.repeat(64); }),
    longitud: variar((r) => { r.abstract_bytes += 1; }),
    jsonRoto: variar((r) => { r.abstract_canonical = r.abstract_canonical.slice(0, -2); }),
    noCanonico: variar((r) => { r.abstract_canonical = JSON.stringify(JSON.parse(r.abstract_canonical), null, 1); r.abstract_bytes = utf8Length(r.abstract_canonical);
      r.abstract_sha256 = createHash('sha256').update(r.abstract_canonical).digest('hex'); }),
  };
  const x2mal = {};
  for (const [k, v] of Object.entries(alterados)) {
    const res = (await dossier({ attempts: [S(x2s), F(v)], closure: true })).result;
    x2mal[k] = res.denominators.D3.value === 0 && codes(res).includes('abstract_gap') && res.verdict === 'incomplete';
  }
  const x2rep = await leer(['101'], 'l1');
  records.set('101', article({ pmid: '101', abstract: [{ text: 'Corrected abstract text.' }] }));
  const x2v2 = await leer(['101'], 'l1');
  const x2ok = (await dossier({ attempts: [S(x2s), F(x2f), F(x2rep), F(x2v2)], closure: true })).result;
  const versiones = prov(x2ok, '101').reading.versions;
  check('X2', Object.values(x2mal).every(Boolean) && x2ok.denominators.D3.value === 1 && versiones.length === 2
    && versiones[0].attempts.length === 2 && x2ok.denominators.D3.multiple_versions.join() === '101'
    && x2ok.notices.some((n) => /repite idéntico/.test(n)) && x2ok.notices.some((n) => /2 versiones completas distintas/.test(n))
    && versiones[0].abstract_sha256 !== versiones[1].abstract_sha256,
    `cambios: huella alterada, longitud falsa, cadena cortada o no canónica (aunque recalcule su huella) no cuentan; repetición idéntica deduplicada con aviso; dos versiones completas separadas y un solo PMID${
      Object.entries(x2mal).some(([, v]) => !v) ? ` — mal: ${Object.entries(x2mal).filter(([, v]) => !v).map(([k]) => k).join(', ')}` : ''}`);

  // X3. El patrón histórico de P-r2: quince pedidos, diez íntegros.
  queries.clear(); records.clear();
  const quince = Array.from({ length: 15 }, (_, i) => String(201 + i));
  queries.set('p[tiab]', { ids: quince });
  const x3s = await buscar('p[tiab]', { retmax: 15 });
  const tandas = [await leer(quince.slice(0, 5), 'l1'), await leer(quince.slice(5, 10), 'l2'), await leer(quince.slice(10), 'l3')];
  const cortada = structuredClone(tandas[2]);
  for (const r of cortada.result.structuredContent.results) r.abstract_canonical = r.abstract_canonical.slice(0, 40);
  const x3 = (await dossier({ attempts: [S(x3s), F(tandas[0]), F(tandas[1]), { ...F(cortada), captured: 'transcribed' }], closure: true })).result;
  check('X3', x3.denominators.D3.value === 10 && x3.denominators.D3.requested_unique === 15 && x3.denominators.D3.abstract_gap.length === 5
    && x3.verdict === 'incomplete' && x3.capture.transcribed.length === 1,
    `P-r2: quince PMID pedidos y diez abstracts íntegros dan D3 = 10 e incomplete, aunque el emisor declarara entrega completa — D3 ${x3.denominators.D3.value}, ${x3.verdict}`);

  // X4. Captura: el cierre lo prueba la captura, no la etiqueta; un arnés que omite una llamada no aprueba.
  queries.clear(); records.clear();
  queries.set('c[tiab]', { ids: ['301'] });
  const x4s = await buscar('c[tiab]');
  const x4f = await leer(['301']);
  const respuesta4 = 'Ver PMID 301.';
  const uso4 = { declared_by: 'native_export', uses: [{ source: { type: 'pmid', value: '301' }, fragment: 'PMID 301' }] };
  const base4 = { attempts: [S(x4s), F(x4f)], response: respuesta4, citations: uso4 };
  const x4 = {
    benchCerrado: (await dossier({ ...base4, closure: true })).result,
    benchSinCierre: (await dossier({ ...base4, closure: false })).result,
    superficieCerrada: (await dossier({ ...base4, profile: 'surface', inventoryBy: 'human', closure: true })).result,
    superficieModelo: (await dossier({ ...base4, profile: 'surface', inventoryBy: 'model', closure: false })).result,
    arnesOmite: (await dossier({ ...base4, closure: true, logExtra: [{ external_id: 'call-fallida', tool: 'pubmed_search_exact', sequence: 9 }] })).result,
    copiaRepetida: (await dossier({ ...base4, attempts: [S(x4s), F(x4f), { ...F(x4f), ext: 'call-1' }], closure: false })).result,
  };
  check('X4', x4.benchCerrado.verdict === 'consistent' && x4.benchCerrado.exit_code === 0 && x4.benchCerrado.capture.inventory_completeness === 'closed'
    && x4.benchSinCierre.verdict === 'inconclusive' && x4.benchSinCierre.capture.inventory_completeness === 'unknown'
    && x4.superficieCerrada.verdict === 'consistent' && x4.superficieModelo.verdict === 'inconclusive' && x4.superficieModelo.exit_code === 2
    && x4.arnesOmite.verdict === 'incomplete' && codes(x4.arnesOmite).includes('closure_mismatch')
    && x4.copiaRepetida.attempts.filter((a) => a.status === 'duplicate_copy').length === 1 && x4.copiaRepetida.denominators.D3.attempts === 1,
    `perfiles: bench o surface con cierre probado, consistent; sin cierre, inconclusive por mucho que diga bench; una llamada en la captura que el inventario omite, incomplete; una copia repetida cuenta una vez — ${
      Object.entries(x4).map(([k, v]) => `${k}:${v.verdict}`).join(', ')}`);

  // X5. Dossier: misma consulta en dos recorridos, colisión de etiquetas, conteos variables, fallida con lista,
  // intento esperado ausente, intento sin respuesta, archivo alterado y unión de una recuperación completa.
  queries.clear(); records.clear();
  queries.set('d[tiab]', { ids: ['401', '402', '403', '404'] });
  queries.set('e[tiab]', { ids: ['405'] });
  queries.set('roto[tiab]', { ids: ['406'], broken: true });
  const x5a = await buscar('d[tiab]');
  const x5b = await buscar('d[tiab]');
  const x5otra = await buscar('e[tiab]');
  const x5p1 = await buscar('d[tiab]', { retmax: 2 });
  queries.set('d[tiab]', { ids: ['401', '402', '403', '404'], count: 5 });
  const x5c = await buscar('d[tiab]');
  // El recuento cambia entre la página 1 y la 2: no hay tramo repetido que lo delate, solo el recuento.
  const x5p2 = await buscar('d[tiab]', { retmax: 2, retstart: 2 });
  // Una lista retocada con la huella del ARCHIVO recalculada: solo la huella del recibo lo delata.
  const x5retocado = structuredClone(x5a);
  x5retocado.result.structuredContent.pmids[0] = '409';
  x5retocado.result.content[0].text = JSON.stringify(x5retocado.result.structuredContent);
  const x5roto = await buscar('roto[tiab]', { pass: 'p2' });
  queries.set('d[tiab]', { ids: ['401', '402', '403', '404'] });
  const pagina1 = await buscar('d[tiab]', { retmax: 2, path: 'complete_retrieval', pass: 'p2' });
  const pagina2 = await buscar('d[tiab]', { retmax: 2, retstart: 2, path: 'complete_retrieval', pass: 'p2' });
  const x5 = {
    dosRecorridos: (await dossier({ attempts: [{ ...S(x5a), walk: 'w1' }, { ...S(x5b), walk: 'w2' }], closure: true })).result,
    colision: (await dossier({ attempts: [S(x5a), S(x5otra)], closure: true })).result,
    conteos: (await dossier({ attempts: [{ ...S(x5a), walk: 'w1' }, { ...S(x5c), walk: 'w1' }], closure: true })).result,
    conteosEntrePaginas: (await dossier({ attempts: [S(x5p1), S(x5p2)], closure: true })).result,
    reciboRetocado: (await dossier({ attempts: [S(x5retocado)], closure: true })).result,
    fallidaConLista: (await dossier({ attempts: [S(x5a), S(x5roto)], closure: true })).result,
    esperadoAusente: (await dossier({ attempts: [S(x5a), F(await leer(['401']))], closure: true, tamper: { 'intentos/1.json': () => undefined } })).result,
    sinRespuesta: (await dossier({ attempts: [S(x5a), { tool: 'pubmed_fetch_exact' }], closure: true })).result,
    alterado: (await dossier({ attempts: [S(x5a)], closure: true, tamper: { 'intentos/0.json': (b) => enc(new TextDecoder().decode(b).replace('401', '409')) } })).result,
    unionCompleta: (await dossier({ attempts: [S(pagina1), S(pagina2)], closure: true })).result,
    unionIncompleta: (await dossier({ attempts: [S(pagina1)], closure: true })).result,
    fueraDePlan: (await dossier({ attempts: [S(x5a)], closure: true, plans: [{ plan_ref: 'plan-9', passes: ['p1'] }] })).result,
  };
  const pasada = (res, id) => res.denominators.D1.per_pass.filter((p) => p.pass_id === id);
  check('X5', x5.dosRecorridos.denominators.D1.per_pass.length === 2 && x5.dosRecorridos.denominators.D1.per_pass.every((p) => p.value === 4)
    && x5.dosRecorridos.denominators.D2.value === 4 && !codes(x5.dosRecorridos).includes('walk_conflict')
    && codes(x5.colision).includes('walk_conflict') && pasada(x5.colision, 'p1')[0].status === 'conflict'
    && pasada(x5.conteos, 'p1')[0].status === 'conflict' && pasada(x5.conteos, 'p1')[0].value === null && pasada(x5.conteos, 'p1')[0].observed.length === 2
    && x5.conteosEntrePaginas.verdict === 'incomplete' && codes(x5.conteosEntrePaginas).includes('count_conflict')
    && pasada(x5.conteosEntrePaginas, 'p1')[0].status === 'conflict' && pasada(x5.conteosEntrePaginas, 'p1')[0].value === null
    && !codes(x5.conteosEntrePaginas).includes('walk_conflict') && x5.conteosEntrePaginas.denominators.D2.value === 4
    && codes(x5.reciboRetocado).includes('search_receipt') && !codes(x5.reciboRetocado).includes('hash_mismatch') && x5.reciboRetocado.denominators.D2.value === 0
    && x5.fallidaConLista.denominators.D2.value === 4 && x5.fallidaConLista.exclusions.some((x) => /integridad failed/.test(x.reason))
    && codes(x5.esperadoAusente).includes('file_missing') && x5.esperadoAusente.verdict === 'incomplete'
    && x5.sinRespuesta.attempts[1].status === 'no_response' && !codes(x5.sinRespuesta).includes('file_missing')
    && codes(x5.alterado).includes('hash_mismatch') && x5.alterado.denominators.D2.value === 0
    && pasada(x5.unionCompleta, 'p2')[0].value === 4 && x5.unionCompleta.passes[0].union.status === 'operational_retrieval_without_snapshot'
    && codes(x5.unionIncompleta).includes('union_failed') && codes(x5.fueraDePlan).includes('outside_plan'),
    'dos recorridos con walk_id no se funden; la misma etiqueta con otra consulta es conflicto; conteos que cambian, conflicto sin elegir; lista con integridad fallida excluida; intento esperado ausente y archivo alterado, defectos; intento sin respuesta declarado, no; unión completa operativa y la que no pasa, defecto');

  // X6. Reintentos 429 y lecturas que nunca se completan.
  queries.clear(); records.clear();
  queries.set('r[tiab]', { ids: ['501', '502'] });
  const x6s = await buscar('r[tiab]');
  const lecturaFallida = (await (async () => { const h2 = createMcpHandler({ fetcher: ncbi('', 429), now, run: RUN });
    return h2({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pubmed_fetch_exact', arguments: { pmids: ['501', '502'], context: { plan_ref: 'plan-1', read_id: 'l1' } } } }); })());
  const x6bien = await leer(['501', '502'], 'l1');
  const x6 = {
    reintentoResuelto: (await dossier({ attempts: [S(x6s), F(lecturaFallida), F(x6bien)], closure: true })).result,
    sinResolver: (await dossier({ attempts: [S(x6s), F(lecturaFallida)], closure: true })).result,
  };
  const pendiente = structuredClone(x6bien);
  const sc = pendiente.result.structuredContent;
  sc.pending_pmids = [{ pmid: '502', reason: 'response_size_limit' }];
  sc.results = sc.results.filter((r) => r.requested_pmid === '501');
  sc.status.delivery = 'partial';
  pendiente.result.content[0].text = JSON.stringify(sc);
  x6.pendienteSinPedir = (await dossier({ attempts: [S(x6s), F(pendiente)], closure: true })).result;
  const contradictorio = structuredClone(pendiente);
  contradictorio.result.structuredContent.status.delivery = 'complete';
  contradictorio.result.content[0].text = JSON.stringify(contradictorio.result.structuredContent);
  x6.contradictorio = (await dossier({ attempts: [S(x6s), F(contradictorio)], closure: true })).result;
  // Un PMID pedido que no está ni entre los resultados ni entre los pendientes: la partición no cuadra.
  const sinParticion = structuredClone(x6bien);
  sinParticion.result.structuredContent.results = sinParticion.result.structuredContent.results.filter((r) => r.requested_pmid === '501');
  sinParticion.result.content[0].text = JSON.stringify(sinParticion.result.structuredContent);
  x6.particion = (await dossier({ attempts: [S(x6s), F(sinParticion)], closure: true })).result;
  check('X6', x6.reintentoResuelto.denominators.D3.value === 2 && !codes(x6.reintentoResuelto).includes('reading_incomplete')
    && x6.reintentoResuelto.denominators.D3.attempts === 2
    && codes(x6.sinResolver).includes('reading_incomplete') && x6.sinResolver.denominators.D3.error.join() === '501,502'
    && codes(x6.pendienteSinPedir).includes('reading_incomplete') && x6.pendienteSinPedir.denominators.D3.pending.join() === '502'
    && codes(x6.contradictorio).includes('fetch_receipt')
    && x6.particion.defects.some((d) => d.code === 'fetch_receipt' && /partición/.test(d.detail)),
    'un 429 seguido de una lectura buena no cambia los numeradores; errores o pendientes nunca resueltos son lectura incompleta; complete con pendientes, contradicción; un PMID pedido sin resultado ni pendiente rompe la partición');

  // X7. Procedencia y temporalidad: con cota fuera de tolerancia, dentro, sin cota, solapada; declaración posterior.
  queries.clear(); records.clear();
  queries.set('k[tiab]', { ids: ['601'] });
  const temporal = async ({ gapMs, clock, between = false }) => {
    const s1 = await buscar('k[tiab]', { known: between ? undefined : [{ pmid: '602', origin: 'model_prior_knowledge' }] });
    salto(gapMs);
    const f1 = await leer(['601', '602'], 'l1');
    const extra = [];
    if (between) {
      salto(gapMs);
      extra.push(S(await buscar('k[tiab]', { pass: 'p2', known: [{ pmid: '602', origin: 'undetermined' }] })));
      salto(gapMs);
      extra.push(F(await leer(['602'], 'l2')));
    }
    return (await dossier({ attempts: [S(s1), F(f1), ...extra], closure: false, clock })).result;
  };
  const x7 = {
    fuera: await temporal({ gapMs: 10000, clock: CLOCK }),
    dentro: await temporal({ gapMs: 0, clock: { skew_bound_ms: 5000, justification: 'desfase medido entre instancias' } }),
    sinCota: await temporal({ gapMs: 10000, clock: null }),
    posterior: await temporal({ gapMs: 10000, clock: CLOCK, between: true }),
  };
  check('X7', prov(x7.fuera, '602').temporality === 'declared_before_fetch' && prov(x7.fuera, '602').membership === 'known_only'
    && prov(x7.dentro, '602').temporality === 'unknown' && prov(x7.sinCota, '602').temporality === 'unknown'
    && prov(x7.posterior, '602').temporality === 'declared_after_fetch'
    && prov(x7.fuera, '601').membership === 'returned' && prov(x7.fuera, '602').known_pmids[0].clock_source === 'server'
    && x7.fuera.capture.clock.skew_bound_ms === 2000 && x7.sinCota.capture.clock.skew_bound_ms === null,
    `temporalidad: declarada antes solo fuera de una cota justificada; dentro de la tolerancia o sin cota, unknown; una declaración tras la primera lectura no la subsana — ${
      Object.entries(x7).map(([k, v]) => `${k}:${prov(v, '602').temporality}`).join(', ')}`);

  // X8. D4: anclas automáticas, mención de un PMID no consultado, uso sin abstract, PMID-DOI solo con identidad explícita.
  queries.clear(); records.clear();
  queries.set('u[tiab]', { ids: ['701', '702'] });
  const x8s = await buscar('u[tiab]');
  const x8f = await leer(['701'], 'l1');
  const texto8 = 'El ensayo (PMID: 701; https://doi.org/10.5555/synthetic.701) y el de pubmed.ncbi.nlm.nih.gov/702 lo apoyan. '
    + 'No consulté PMID 12345678; lo excluyo. Ver también 10.1016/S0140-6736(20)30183-5).';
  const cand = extractCandidates(texto8);
  const usos8 = (links, extra = []) => ({ declared_by: 'agent', identity_links: links, uses: [
    { source: { type: 'pmid', value: '701' }, fragment: 'PMID: 701' },
    { source: { type: 'doi', value: '10.5555/synthetic.701' }, fragment: '10.5555/synthetic.701' },
    { source: { type: 'pmid', value: '702' }, fragment: 'pubmed.ncbi.nlm.nih.gov/702' }, ...extra] });
  const x8 = {
    soloRespuesta: (await dossier({ attempts: [S(x8s), F(x8f)], response: texto8, closure: true })).result,
    sinVinculo: (await dossier({ attempts: [S(x8s)], response: texto8, usage: usos8([]), closure: true })).result,
    conRegistro: (await dossier({ attempts: [S(x8s), F(x8f)], response: texto8, usage: usos8([]), closure: true })).result,
    conEnlace: (await dossier({ attempts: [S(x8s)], response: texto8, usage: usos8([{ pmid: '701', doi: '10.5555/synthetic.701' }]), closure: true })).result,
    anclaFalsa: (await dossier({ attempts: [S(x8s), F(x8f)], response: texto8, usage: usos8([], [{ source: { type: 'pmid', value: '703' }, fragment: 'PMID 703' }]), closure: true })).result,
    sinRespuesta: (await dossier({ attempts: [S(x8s), F(x8f)], closure: true })).result,
  };
  const d4 = (k) => x8[k].denominators.D4;
  check('X8', cand.map((c) => `${c.type}:${c.value}`).join() === 'pmid:701,doi:10.5555/synthetic.701,pmid:702,pmid:12345678,doi:10.1016/s0140-6736(20)30183-5'
    && cand.every((c) => texto8.slice(c.start, c.end) === c.text)
    && d4('soloRespuesta').status === 'not_measured' && d4('soloRespuesta').value === null && d4('soloRespuesta').mentions_without_use_evidence.length === 5
    && x8.soloRespuesta.verdict === 'inconclusive'
    && d4('sinVinculo').value === 3 && d4('sinVinculo').pmid_sources === 2
    && d4('conRegistro').value === 2 && d4('conEnlace').value === 2
    && d4('conRegistro').used_without_preserved_abstract.join() === '702'
    && d4('conRegistro').mentions_without_use_evidence.some((m) => m.value === '12345678')
    && codes(x8.anclaFalsa).includes('use_anchor') && d4('anclaFalsa').value === 2
    && d4('sinRespuesta').status === 'not_measured',
    `D4: anclas automáticas con intervalo exacto; una mención (también «no consulté PMID…») no suma; sin vínculo explícito PMID y DOI son dos documentos, con el registro leído o un enlace, uno; ancla que no está, defecto — D4 ${
      ['soloRespuesta', 'sinVinculo', 'conRegistro', 'conEnlace'].map((k) => `${k}:${d4(k).value}`).join(', ')}`);

  // X9. Referencia: sin ella, R vacía o parcial, revisión de origen separada de sus primarios, PMID ajenos,
  // caso de cases.json, intersección conservada; la fuente de verdad no se toca.
  queries.clear(); records.clear();
  queries.set('ref[tiab]', { ids: ['801', '802', '899'] });
  queries.set('(ref[tiab]) AND (801[pmid] OR 802[pmid] OR 803[pmid])', { ids: ['801', '802'] });
  queries.set('(ref[tiab]) AND (801[pmid])', { ids: ['801'] });
  const x9s = await buscar('ref[tiab]');
  const x9i = await buscar('(ref[tiab]) AND (801[pmid] OR 802[pmid] OR 803[pmid])');
  const x9mal = await buscar('(ref[tiab]) AND (801[pmid])');
  const ref9 = (target, synthesis = [], partial = true) => ({ json: { format: 'pubmed-dossier-reference', format_version: 1, reference_id: 'R9', version: '1',
    source: 'test', partial, target_pmids: target, synthesis_pmids: synthesis } });
  const casesJson = readFileSync(join(ROOT, 'scripts', 'eval', 'cases.json'), 'utf8');
  const casoA = JSON.parse(casesJson).cases.find((c) => c.id === 'A').reference;
  const x9 = {
    sin: (await dossier({ attempts: [S(x9s)], closure: true })).result,
    vacia: (await dossier({ attempts: [S(x9s)], closure: true, reference: ref9([]) })).result,
    parcial: (await dossier({ attempts: [S(x9s)], closure: true, reference: ref9(['801', '802', '803'], ['899']) })).result,
    intersec: (await dossier({ attempts: [S(x9s)], closure: true, reference: ref9(['801', '802', '803']), intersections: [{ raw: x9i, plan: 'plan-1', pass: 'p1' }] })).result,
    intersecMal: (await dossier({ attempts: [S(x9s)], closure: true, reference: ref9(['801', '802', '803']), intersections: [{ raw: x9mal, plan: 'plan-1', pass: 'p1' }] })).result,
    sintesisEnObjetivo: (await dossier({ attempts: [S(x9s)], closure: true, reference: ref9(['801'], ['801']) })).result,
    caso: await dossier({ attempts: [S(x9s)], closure: true, reference: { json: casesJson, case_id: 'A' } }),
  };
  const st = (k, s) => stage(x9[k], s);
  const casoRes = x9.caso.result;
  check('X9', x9.sin.retention.status === 'not_measured' && st('vacia', 'returned').ratio === null && st('vacia', 'returned').denominator === 0
    && st('parcial', 'returned').ratio === 2 / 3 && st('parcial', 'returned').missing.join() === '803' && x9.parcial.retention.reference.partial === true
    && x9.parcial.retention.synthesis.returned.join() === '899' && x9.parcial.retention.outside_reference.returned === 0
    && x9.parcial.retention.within_query.status === 'not_measured'
    && x9.intersec.retention.within_query[0]?.ratio === 2 / 3 && /intersección/.test(x9.intersec.retention.within_query[0]?.via ?? '')
    && codes(x9.intersecMal).includes('intersection')
    && x9.sintesisEnObjetivo.uncertainties.some((u) => /síntesis/.test(u.detail))
    && casoRes.retention.reference.target_size === casoA.pmids.length && casoRes.retention.reference.synthesis_pmids.join() === casoA.source_pmid
    && casoRes.retention.reference.partial === (casoA.complete === false)
    && new TextDecoder().decode(x9.caso.store.get('referencia.json')) === casesJson && readFileSync(join(ROOT, 'scripts', 'eval', 'cases.json'), 'utf8') === casesJson,
    'retención: sin referencia, no medida; R vacía, ratio null (no 100 %); parcial con faltantes, síntesis aparte y ajenos fuera; intersección conservada solo con la composición exacta; caso de cases.json; la referencia queda intacta');

  // X10. Ruta alternativa y entradas ilegibles.
  const x10 = {
    otroConector: (await dossier({ attempts: [{ tool: 'other', raw: { tool: 'search_articles', query: 'natural language' } }], closure: true })).result,
    ilegible: (await dossier({ attempts: [{ tool: 'pubmed_search_exact', raw: 'no es json {' }], closure: true })).result,
    manifiestoRoto: await checkDossier({ format: 'pubmed-dossier-manifest', format_version: 1, attempts: [{ file: '../fuera.json' }] }, async () => null),
  };
  check('X10', x10.otroConector.alternative_route.length === 1 && x10.otroConector.denominators.D3.value === 0
    && x10.otroConector.uncertainties.some((u) => u.code === 'no_exact_search') && x10.otroConector.verdict === 'inconclusive'
    && x10.ilegible.verdict === 'inconclusive' && x10.ilegible.uncertainties.some((u) => u.code === 'unreadable')
    && x10.manifiestoRoto.verdict === 'inconclusive' && x10.manifiestoRoto.uncertainties.some((u) => /ruta relativa/.test(u.detail)),
    'llamadas con otro conector, registradas como ruta alternativa y nunca como lectura exacta; entradas ilegibles o manifiesto con rutas fuera de su carpeta, inconclusive');

  // --- X11-X16. Contraejemplos de la revisión de Codex del 25/10 (R1-R5, R9), cada uno contra un control
  // positivo que da consistent. Sintéticos: prueban el contrato, no son fallos observados en ChatGPT.
  queries.clear(); records.clear();
  queries.set('ctl[tiab]', { ids: ['11', '22'] });
  const ctlS = await buscar('ctl[tiab]');
  const ctlF = await leer(['11', '22'], 'lc');
  const respuestaCtl = 'According to PMID 11.';
  const usoCtl = (uses = [{ source: { type: 'pmid', value: '11' }, fragment: 'PMID 11' }]) => ({ declared_by: 'agent', uses });
  const tocar = (env, fn) => {
    const c = structuredClone(env);
    fn(c.result.structuredContent);
    c.result.content[0].text = JSON.stringify(c.result.structuredContent);
    return c;
  };
  const control = async ({ s = ctlS, f = ctlF, usage = usoCtl(), extra = [] } = {}) => (await dossier({
    attempts: [S(s), F(f), ...extra], response: respuestaCtl, usage, closure: true })).result;
  const ctl = await control();

  // X11 (R1). La forma y las relaciones del recibo se validan antes de usarlo: lo que no tiene la forma es
  // incertidumbre, una contradicción demostrable es defecto, y nada tumba el comprobador.
  const knownMal = structuredClone(ctlS);
  knownMal.result.structuredContent.selection_record.record.known_pmids = { pmid: '11' };
  knownMal.result.structuredContent.selection_record.sha256 = await sha256(JSON.stringify(knownMal.result.structuredContent.selection_record.record));
  knownMal.result.content[0].text = JSON.stringify(knownMal.result.structuredContent);
  const x11 = {
    sinProcedencia: await control({ f: tocar(ctlF, (sc) => { for (const k of ['run', 'attempt_id', 'received_at', 'executed_at', 'completed_at', 'engine', 'provider', 'endpoint', 'transport', 'limits']) delete sc[k]; }) }),
    resultadoNull: await control({ f: tocar(ctlF, (sc) => { sc.results[0] = null; }) }),
    knownMalformado: await control({ s: knownMal }),
    recuentoMenor: await control({ s: tocar(ctlS, (sc) => { sc.result_count = 0; }) }),
    retmaxIncompatible: await control({ s: tocar(ctlS, (sc) => { sc.request.retmax_sent = 0; }) }),
    continuacionFalsa: await control({ s: tocar(ctlS, (sc) => { sc.next_retstart = 2; sc.next_retstart_reason = null; }) }),
    completoFalso: await control({ s: tocar(ctlS, (sc) => { sc.records_complete = false; }) }),
  };
  const formaMala = ['sinProcedencia', 'resultadoNull', 'knownMalformado'];
  const relacionMala = ['recuentoMenor', 'retmaxIncompatible', 'continuacionFalsa', 'completoFalso'];
  check('X11', ctl.verdict === 'consistent'
    && formaMala.every((k) => x11[k].verdict === 'inconclusive' && x11[k].uncertainties.some((u) => u.code === 'unsupported_input')
      && !x11[k].uncertainties.some((u) => u.code === 'checker_exception'))
    && x11.sinProcedencia.denominators.D3.value === 0
    && relacionMala.every((k) => x11[k].verdict === 'incomplete' && codes(x11[k]).includes('search_receipt') && x11[k].denominators.D2.value === 0),
    `forma antes que uso: sin procedencia, resultado null o known_pmids malformado, inconclusive sin excepción; recuento menor que la lista, retmax incompatible, continuación o completitud falsas, incomplete — ${
      Object.entries(x11).map(([k, v]) => `${k}:${v.verdict}`).join(', ')}`);

  // X12 (R2). Solo suma D3 el abstract íntegro atribuible a su PMID; un recibo con la identidad o la entrega
  // fallidas no acredita ninguno. Un unsupported con registros bien atribuidos sí los acredita.
  const x12 = {
    returnedDistinto: await control({ f: tocar(ctlF, (sc) => { sc.results[0].returned_pmid = '99'; }) }),
    identidadFailed: await control({ f: tocar(ctlF, (sc) => { sc.status = { record_identity: 'failed', delivery: 'failed' }; }) }),
    unsupportedAtribuible: await control({ f: tocar(ctlF, (sc) => { sc.status.record_identity = 'unsupported'; }) }),
  };
  check('X12', x12.returnedDistinto.denominators.D3.value === 1 && x12.returnedDistinto.denominators.D3.obtained.join() === '22'
    && x12.returnedDistinto.denominators.D3.not_attributable.join() === '11' && x12.returnedDistinto.verdict === 'incomplete'
    && x12.identidadFailed.denominators.D3.value === 0 && x12.identidadFailed.verdict === 'incomplete'
    && x12.unsupportedAtribuible.denominators.D3.value === 2,
    `D3 solo con identidad válida: returned_pmid distinto, D3 ${x12.returnedDistinto.denominators.D3.value}; identidad failed, D3 ${
      x12.identidadFailed.denominators.D3.value}; unsupported bien atribuido, D3 ${x12.unsupportedAtribuible.denominators.D3.value}`);

  // X13 (R3). Una lectura sin respuesta no desaparece: sin la petición, inconclusive; con ella, sus PMID quedan
  // por resolver (incomplete) salvo que otra lectura conservada los resuelva.
  const x13 = {
    sinPeticion: await control({ extra: [{ tool: 'pubmed_fetch_exact' }] }),
    conPeticion: await control({ extra: [{ tool: 'pubmed_fetch_exact', request: { pmids: ['33'] } }] }),
    resueltaPorOtra: await control({ extra: [{ tool: 'pubmed_fetch_exact', request: { pmids: ['22'] } }] }),
  };
  check('X13', x13.sinPeticion.verdict === 'inconclusive' && x13.sinPeticion.uncertainties.some((u) => u.code === 'reading_without_response')
    && x13.conPeticion.verdict === 'incomplete' && x13.conPeticion.denominators.D3.no_response.join() === '33'
    && x13.resueltaPorOtra.verdict === 'consistent',
    `lectura sin respuesta: sin petición ${x13.sinPeticion.verdict}, con petición ${x13.conPeticion.verdict}, resuelta por otra lectura ${x13.resueltaPorOtra.verdict}`);

  // X14 (R4). Recuentos distintos entre páginas de una pasada: defecto, aunque otra pasada tenga D1 medido.
  queries.set('cc[tiab]', { ids: ['41', '42', '43', '44'], count: 4 });
  const cc1 = await buscar('cc[tiab]', { retmax: 2 });
  queries.set('cc[tiab]', { ids: ['41', '42', '43', '44'], count: 5 });
  const cc2 = await buscar('cc[tiab]', { retmax: 2, retstart: 2 });
  const ccOtra = await buscar('ctl[tiab]', { pass: 'p2' });
  const x14 = (await dossier({ attempts: [S(cc1), S(cc2), S(ccOtra), F(ctlF)], response: respuestaCtl, usage: usoCtl(), closure: true })).result;
  check('X14', x14.verdict === 'incomplete' && codes(x14).includes('count_conflict')
    && pasada(x14, 'p1')[0].status === 'conflict' && pasada(x14, 'p1')[0].value === null && pasada(x14, 'p2')[0].status === 'measured',
    `D1 en conflicto en una pasada impide aprobar aunque otra pasada mida D1 — ${x14.verdict}`);

  // X15 (R5). Dos PMID con el mismo abstract canónico: una referencia de uso se comprueba por el par
  // [pmid, huella], no por la huella sola.
  records.set('11', article({ pmid: '11', abstract: [{ text: 'Identical abstract.' }] }));
  records.set('22', article({ pmid: '22', abstract: [{ text: 'Identical abstract.' }] }));
  const gemelos = await leer(['11', '22'], 'lg');
  const [g11, g22] = gemelos.result.structuredContent.results;
  const x15 = await control({ f: gemelos, usage: usoCtl([{ source: { type: 'pmid', value: '11' }, fragment: 'PMID 11',
    abstract_ref: { pmid: '11', abstract_sha256: g11.abstract_sha256 } }]) });
  const x15otro = await control({ f: gemelos, usage: usoCtl([{ source: { type: 'pmid', value: '11' }, fragment: 'PMID 11',
    abstract_ref: { pmid: '33', abstract_sha256: g11.abstract_sha256 } }]) });
  check('X15', g11.abstract_sha256 === g22.abstract_sha256 && x15.verdict === 'consistent' && x15.denominators.D4.value === 1
    && codes(x15otro).includes('use_anchor'),
    `misma huella en dos PMID: la referencia al par de 11 resuelve (${x15.verdict}, D4 ${x15.denominators.D4.value}); a un PMID que no la tiene, no`);
  records.clear();

  // X16 (R9). Usos declarados sin ancla no son cero usos medidos; cero usos declarado explícitamente sí.
  const x16 = {
    sinAncla: await control({ usage: usoCtl([{ source: { type: 'pmid', value: '11' } }]) }),
    ceroExplicito: await control({ usage: usoCtl([]) }),
    parcial: await control({ usage: usoCtl([{ source: { type: 'pmid', value: '11' }, fragment: 'PMID 11' }, { source: { type: 'pmid', value: '22' } }]) }),
  };
  check('X16', x16.sinAncla.denominators.D4.status === 'not_measured' && x16.sinAncla.denominators.D4.value === null
    && x16.sinAncla.denominators.D4.declared_unverified.length === 1 && x16.sinAncla.verdict === 'inconclusive'
    && x16.ceroExplicito.denominators.D4.status === 'measured' && x16.ceroExplicito.denominators.D4.value === 0 && x16.ceroExplicito.verdict === 'consistent'
    && x16.parcial.denominators.D4.status === 'partial' && x16.parcial.denominators.D4.value === 1 && x16.parcial.verdict === 'inconclusive',
    `D4: sin ancla ${x16.sinAncla.denominators.D4.status}, cero explícito ${x16.ceroExplicito.denominators.D4.status} (${x16.ceroExplicito.verdict}), parcial ${x16.parcial.denominators.D4.status} (${x16.parcial.verdict})`);
} catch (err) {
  check('X0', false, `la parte del dossier se interrumpió: ${String(err?.stack ?? err).split('\n').slice(0, 2).join(' | ')}`);
}

for (const l of pass) console.log(`  pass  ${l}`);
for (const l of fail) console.log(`  FAIL  ${l}`);
console.log(`\n${pass.length} pass / ${fail.length} fail`);
process.exit(fail.length === 0 ? 0 : 1);
