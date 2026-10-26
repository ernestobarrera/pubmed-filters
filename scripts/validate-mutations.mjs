#!/usr/bin/env node
/**
 * Puerta de mutación: comprueba que la suite de conformidad SABE RECHAZAR una implementación mala.
 *
 * POR QUÉ EXISTE. Una suite en verde no prueba nada por sí sola: prueba que nada de lo que mira
 * está roto, que es distinto. Tres veces en septiembre de 2026 una comprobación de este repositorio
 * o de un adaptador suyo estuvo vigilando un fallo **que ya estaba presente**:
 *
 *   · las pruebas de transporte de `qa-pubmed.mjs` miraban el constructor de la petición, no la
 *     petición entregada: truncar el cuerpo después de construirlo dejaba la suite en verde;
 *   · el resumen de esa misma suite se calculaba antes de sus últimas comprobaciones, así que
 *     imprimía los fallos y devolvía código 0;
 *   · una comprobación acreditaba POST buscando la cadena `method: 'POST'` en el fichero, de modo
 *     que dejarla en un comentario y enviar un GET real pasaba 48/0.
 *
 * Las tres las encontró una persona o otro agente leyendo el código. Ninguna la encontró el banco.
 * Esta puerta convierte esa lectura en algo que corre en CI: cada mutación de la tabla tiene que
 * romper la comprobación que dice vigilarla. Si una mutación pasa, la comprobación es decorativa y
 * esta puerta falla.
 *
 * CÓMO FUNCIONA. Muta el fichero EN SITIO, ejecuta la suite en otro proceso, y restaura siempre
 * —haya ido bien o mal—. Se niega a arrancar si el árbol de git está sucio, para que un corte a
 * mitad no pueda llevarse por delante trabajo sin guardar. Al terminar verifica que el contenido
 * restaurado es byte a byte el original.
 *
 * Uso:  node scripts/validate-mutations.mjs
 * Sale: 0 si todas las mutaciones se detectan, 1 si alguna sobrevive.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Cada entrada es una forma concreta de equivocarse, tomada de un fallo real o de la clase de fallo
 * que una comprobación dice cubrir. `rompe` es la comprobación que DEBE caer: si cae otra y no esa,
 * la comprobación no vigila lo que cree vigilar y esto también se declara fallo.
 */
const MUTACIONES = [
  {
    id: 'D1-SIN-ENTORNO',
    porque: 'el despliegue vuelve a permitir una sesión OAuth de respaldo cuando faltan token o cuenta explícitos',
    fichero: 'mcp/stamp.mjs',
    de: 'if (environmentError) {',
    a: 'if (false && environmentError) {',
    rompe: 'D1',
  },
  {
    id: 'T1-GET',
    porque: 'la consulta vuelve a viajar por GET, con term en la URL: el fallo que la 1.8.0 cerro',
    fichero: 'scripts/esearch.mjs',
    // Reproduce el defecto COMO SERIA: un GET de verdad, con la consulta en la query string. La
    // primera version solo cambiaba `method` y dejaba el cuerpo, que ningun regreso real a GET
    // escribiria —y que `fetch` ni siquiera acepta—. Caia T1 igual, porque la suite usa un fetcher
    // de prueba y veia el metodo entregado; pero una mutacion debe parecerse al fallo que vigila,
    // no bastarle con tumbar la comprobacion. Lo senalo Codex el 2026-10-01.
    de: 'const response = await fetcher(ESEARCH_URL, { method: TRANSPORT, body, ...(signal ? { signal } : {}) });',
    a: "const response = await fetcher(`${ESEARCH_URL}?${body}`, { method: 'GET' });",
    rompe: 'T1',
  },
  {
    id: 'T1-TRUNCA',
    porque: 'el cuerpo se trunca DESPUES de construirlo, que es como una prueba de transporte pasa en verde vigilando el truncado',
    fichero: 'scripts/esearch.mjs',
    de: '...params, term })',
    a: '...params, term: term.slice(0, 10) })',
    rompe: 'T1',
  },
  {
    id: 'T1-FUERA',
    porque: 'un script vuelve a hablar con el servicio por su cuenta, fuera del unico modulo que lo hace',
    fichero: 'scripts/quickstart.mjs',
    de: "import { esearch } from './esearch.mjs';",
    // Hace una LLAMADA de verdad, no solo una constante con la URL. La primera versión declaraba
    // una constante y ya: C12 caía porque encuentra el texto, no porque hubiera una llamada fuera
    // del módulo. Era otro mutante EQUIVALENTE, y lo señaló Codex el 2026-09-30 con razón, porque
    // el defecto anunciado no se producía. De paso deja ver algo del propio C12, que acredita por
    // texto: esta mutación demuestra que C12 reacciona, no que sepa distinguir una llamada.
    //
    // La URL va partida en el literal. Escrita entera, C12 caza ESTE fichero —«servicio nombrado
    // fuera de esearch.mjs»— y la suite se pone en rojo antes de empezar: la puerta cazó a quien la
    // escribía. Se parte en vez de eximir este fichero en C12, porque una exención es una
    // comprobación un poco más floja para siempre.
    a: "import { esearch } from './esearch.mjs';\n"
      + "export async function esearchPropio(term) {\n"
      + "  const u = new URL('https://eutils"
      + ".ncbi.nlm.nih.gov/entrez/eutils/esearch" + ".fcgi');\n"
      + "  u.searchParams.set('db', 'pubmed');\n"
      + "  u.searchParams.set('term', term);\n"
      + "  return (await fetch(u)).json();\n"
      + "}",
    rompe: 'C12',
  },
  {
    id: 'T2-CERO',
    porque: 'un 414 se presenta como un recuento de cero en vez de como fallo de transporte: el disfraz exacto que el contrato prohibe',
    fichero: 'scripts/esearch.mjs',
    de: 'if (response.status === 413 || response.status === 414) throw new TransportError(response.status);',
    a: "if (response.status === 413 || response.status === 414) "
      + "return { transport: TRANSPORT, esearchresult: { count: '0', querytranslation: term } };",
    rompe: 'T2',
  },
  {
    id: 'R14-ERRATA',
    porque: 'vuelve la errata real de spanish.txt: «O R» en vez de «OR», que PubMed no rechaza, parte la consulta y devuelve un recuento plausible',
    fichero: 'filters/scope/spanish.txt',
    de: 'lerida[ad] OR girona[ad]',
    a: 'lerida[ad] O R girona[ad]',
    rompe: 'R14',
  },
  {
    id: 'M1',
    porque: 'los vectores vuelven a quedarse congelados, como estaban en la 1.7.1',
    fichero: 'neurosymbolic_router.json',
    // Se quita UN vector con su coma: quitar los dos dejaba una coma colgando y el JSON inválido,
    // así que la suite moría por un error de sintaxis en vez de fallar C9. Una mutación que rompe el
    // fichero no prueba que la comprobación funcione; prueba que JSON.parse funciona.
    de: ',\n        "dropped_term_with_results"',
    a: '',
    rompe: 'C9',
  },
  {
    id: 'M2',
    porque: 'sin declarar qué es prosa rectora, cualquier regla puede eximirse sola',
    fichero: 'neurosymbolic_router.json',
    de: '"guiding_prose_not_a_vector"',
    a: '"guiding_prose_not_a_vector_DESACTIVADO"',
    rompe: 'C9',
  },
  {
    id: 'M3',
    porque: 'un recuento ausente o no numérico vuelve a pasar por recuento (regresión de la 1.7.1)',
    fichero: 'scripts/parse-filter.mjs',
    de: 'const countIsValid = ',
    a: 'const countIsValid = true || ',
    rompe: 'Q7',
  },
  {
    id: 'M7',
    porque: 'el recuento vuelve a juzgarse con Number(): «0x10» pasa como 16 y «1e3» como 1000',
    fichero: 'scripts/parse-filter.mjs',
    de: '? /^[0-9]+$/.test(rawCount)',
    a: "? String(rawCount).trim() !== '' && Number.isInteger(count) && count >= 0",
    rompe: 'Q7',
  },
  {
    id: 'E-COERCION',
    porque: 'el recibo vuelve a convertir un recuento ausente o malformado en un cero plausible: el `parseInt(count) || 0` de los adaptadores',
    fichero: 'scripts/exact-core.mjs',
    de: 'const count = inspection.countIsValid ? Number(r.count) : null;',
    a: 'const count = parseInt(r.count, 10) || 0;',
    rompe: 'E3',
  },
  {
    id: 'E-COLAPSO',
    porque: 'una consulta que PubMed muestra rota se declara «no verificable»: un defecto conocido escondido detrás de un desconocido',
    fichero: 'scripts/exact-core.mjs',
    de: "if (inspection.anomalies.length > 0) return 'failed';",
    a: "if (inspection.anomalies.length > 0) return 'unsupported';",
    rompe: 'E2',
  },
  {
    id: 'E-REHASH',
    porque: 'el hash se calcula sobre el JSON re-serializado, que es lo que el código entendió y no lo que PubMed respondió',
    fichero: 'scripts/exact-core.mjs',
    de: 'raw_response_sha256: await sha256(raw),',
    a: 'raw_response_sha256: await sha256(JSON.stringify(esearchresult)),',
    rompe: 'E1',
  },
  {
    id: 'E-VENTANA',
    porque: 'la ventana sube a 10.000 por la documentación, cuando PubMed mismo declara 9.999 en su ERROR',
    fichero: 'scripts/exact-core.mjs',
    de: 'export const ESEARCH_WINDOW = 9999;',
    a: 'export const ESEARCH_WINDOW = 10000;',
    rompe: 'E4',
  },
  {
    id: 'R15-ESTADO',
    porque: 'un filtro empieza a usar medline[sb] como proxy de «indexado» y pierde las citas NotIndexed sin avisar',
    fichero: 'filters/clinical/mortality.txt',
    de: 'homicid*[tiab] OR murder*[tiab]',
    a: 'homicid*[tiab] OR murder*[tiab] OR (death[ti] AND medline[sb])',
    rompe: 'R15',
  },
  {
    id: 'C13-POLISEMIA',
    porque: 'failed se extiende a reading_depth por analogía, sin significado propio',
    fichero: 'neurosymbolic_router.json',
    de: '"reading_depth": [\n          "verified",',
    a: '"reading_depth": [\n          "failed",\n          "verified",',
    rompe: 'C13',
  },
  {
    id: 'C13-COBERTURA-SIN-SIGNIFICADO',
    porque: 'coverage conserva failed pero pierde su significado propio: vuelve a ser reutilización por analogía',
    fichero: 'neurosymbolic_router.json',
    de: '"coverage": "A coverage check found',
    a: '"coverage_note": "A coverage check found',
    rompe: 'C13',
  },
  {
    id: 'C14-COBERTURA-OPCIONAL',
    porque: 'un corpus definido vuelve a cerrarse sin mirar qué deja fuera, que es el fallo medido el 2026-10-14',
    fichero: 'neurosymbolic_router.json',
    de: '"coverage_check": "required"',
    a: '"coverage_check": "optional"',
    rompe: 'C14',
  },
  {
    id: 'C14-CORPUS-RECORTABLE',
    porque: 'un corpus definido vuelve a admitir filtros de metodología, revista o fecha para hacerlo legible',
    fichero: 'neurosymbolic_router.json',
    de: '"adaptation": "not_applicable: narrowing',
    a: '"adaptation": "allowed: narrowing',
    rompe: 'C14',
  },
  {
    id: 'C14-SIN-PERLAS',
    porque: 'la comprobación de cobertura pierde las perlas independientes y solo queda la sensibilidad',
    fichero: 'neurosymbolic_router.json',
    de: '"independent_pearls": "2 to 4',
    a: '"pearls_optional": "2 to 4',
    rompe: 'C14',
  },
  {
    id: 'Q8-SIN-ETIQUETAS',
    porque: 'el juicio deja de mirar las etiquetas de la consulta enviada, y una etiqueta inexistente, que PubMed calla, pasa por verificada',
    fichero: 'scripts/parse-filter.mjs',
    de: "const fieldTagsChecked = typeof sentQuery === 'string';",
    a: 'const fieldTagsChecked = true;',
    rompe: 'Q8',
  },
  {
    id: 'Q9-PAGINACION',
    porque: 'el recorte de página vuelve a tratarse como aviso sobre la consulta y una búsqueda íntegra se declara rota',
    fichero: 'scripts/parse-filter.mjs',
    de: 'const pagination = outputmessages.filter((m) => /^Restrictions achieved\\. start and count adjusted to [0-9]+, [0-9]+\\.?$/i.test(m));',
    a: 'const pagination = [];',
    rompe: 'Q9',
  },
  {
    id: 'Q10-TRADUCCION-BLANCA',
    porque: 'una traducción con espacios vuelve a acreditar integridad sin diagnóstico legible',
    fichero: 'scripts/parse-filter.mjs',
    de: 'r.querytranslation.trim().length > 0',
    a: 'r.querytranslation.length > 0',
    rompe: 'Q10',
  },
  {
    id: 'Q11-PREFIJO-PAGINACION',
    porque: 'el prefijo de paginación vuelve a esconder un diagnóstico semántico añadido',
    fichero: 'scripts/parse-filter.mjs',
    de: '/^Restrictions achieved\\. start and count adjusted to [0-9]+, [0-9]+\\.?$/i',
    a: '/^Restrictions achieved\\b/i',
    rompe: 'Q11',
  },
  {
    id: 'E7-CERO',
    porque: 'el ERROR ilegible de PubMed se convierte en un cero: el fallo exacto del conector que lo inspiró',
    fichero: 'scripts/esearch.mjs',
    de: 'const fatal = /',
    a: "return { transport: TRANSPORT, esearchresult: { count: '0', querytranslation: term }, raw };\n    const fatal = /",
    rompe: 'E7',
  },
  {
    id: 'R16-ERRATA',
    porque: 'una errata en una etiqueta de un filtro curado, [tiabb], que PubMed descarta sin avisar',
    fichero: 'filters/clinical/mortality.txt',
    de: 'murder*[tiab]',
    a: 'murder*[tiabb]',
    rompe: 'R16',
  },
  {
    id: 'Q8-ESPACIO',
    porque: 'una etiqueta con un espacio delante vuelve a tratarse como texto, y asthma [tiabb] pasa por verificada (el hallazgo F1 de Codex)',
    fichero: 'scripts/parse-filter.mjs',
    de: "const next = q[close + 1] ?? '';",
    a: "const next = q[close + 1] ?? ''; if (j !== i - 1) { i = close; continue; }",
    rompe: 'Q8',
  },
  {
    id: 'Q8-GRUPO',
    porque: 'una etiqueta sobre un grupo con operadores, que PubMed ignora, deja de vigilarse',
    fichero: 'scripts/parse-filter.mjs',
    de: "if (prev === ')' && groupHasOperator(q, j))",
    a: "if (false && groupHasOperator(q, j))",
    rompe: 'Q8',
  },
  {
    id: 'Q8-MODIFICADOR',
    porque: 'la proximidad en un campo que no la admite, que PubMed tira sin avisar, vuelve a pasar',
    fichero: 'scripts/parse-filter.mjs',
    de: "else if (modifier && modifier !== 'noexp' && !PROXIMITY_TAGS.has(field)) add(raw, 'modificador');",
    a: '',
    rompe: 'Q8',
  },
  {
    id: 'Q8-COMILLAS',
    porque: 'los corchetes dentro de una frase vuelven a leerse como etiqueta: "[18F]FDG"[tiab] sale roto',
    fichero: 'scripts/parse-filter.mjs',
    de: 'if (OPEN_QUOTES.has(c)) { inQuote = true; continue; }',
    a: 'if (false) { inQuote = true; continue; }',
    rompe: 'Q8',
  },
  {
    id: 'Q8-ASTERISCO',
    porque: 'un asterisco tipográfico deja de invalidar la consulta, y PubMed busca la raíz exacta en silencio',
    fichero: 'scripts/parse-filter.mjs',
    de: 'if (lookalikes.length > 0) {',
    a: 'if (false) {',
    rompe: 'Q8',
  },
  {
    id: 'R17-ASTERISCO',
    porque: 'un filtro curado gana un asterisco tipográfico sin declararlo, como horizon.txt',
    fichero: 'filters/clinical/mortality.txt',
    de: 'murder*[tiab]',
    a: 'murder∗[tiab]',
    rompe: 'R17',
  },
  {
    id: 'E8-PRIORIDAD',
    porque: 'la falta de diagnóstico vuelve a mirarse antes que la anomalía, y un ERROR sin traducción sale unsupported',
    fichero: 'scripts/exact-core.mjs',
    de: "if (inspection.anomalies.length > 0) return 'failed';",
    a: "if (!inspection.verifiable) return 'unsupported';\n  if (inspection.anomalies.length > 0) return 'failed';",
    rompe: 'E8',
  },
  {
    id: 'E9-PMIDHASH',
    porque: 'el hash de la lista de PMIDs es fijo y no el de lo recibido: sobrevivía a las dos suites (Codex)',
    fichero: 'scripts/exact-core.mjs',
    de: "pmid_list_sha256: await sha256(pmids.join('\\n')),",
    a: "pmid_list_sha256: await sha256(''),",
    rompe: 'E9',
  },
  {
    id: 'W-ORIGIN',
    porque: 'un origen de navegador no admitido vuelve a atenderse, con CORS abierto',
    fichero: 'mcp/worker.mjs',
    de: "if (origin !== null && !list(env.ALLOWED_ORIGINS).includes(origin)) {",
    a: 'if (false) {',
    rompe: 'W4',
  },
  {
    id: 'W-VERSION',
    porque: 'una MCP-Protocol-Version que no se soporta vuelve a aceptarse',
    fichero: 'mcp/worker.mjs',
    de: "if (version !== null && message?.method !== 'initialize' && !PROTOCOL_VERSIONS.includes(version)) {",
    a: 'if (false) {',
    rompe: 'W5',
  },
  {
    id: 'W-VERSION-SALUDO',
    porque: 'la cabecera vuelve a rechazar el saludo `initialize`, y un cliente con una versión posterior no puede negociar',
    fichero: 'mcp/worker.mjs',
    de: "message?.method !== 'initialize' && !PROTOCOL_VERSIONS",
    a: '!PROTOCOL_VERSIONS',
    rompe: 'W7',
  },
  {
    id: 'W-LOTE',
    porque: 'vuelven los lotes JSON-RPC, que la 2025-06-18 no admite y que multiplican las llamadas a NCBI',
    fichero: 'mcp/worker.mjs',
    de: 'if (Array.isArray(message)) {',
    a: 'if (false) {',
    rompe: 'W2',
  },
  {
    id: 'W-BYTES',
    porque: 'vuelve el código de antes: leer el cuerpo entero y luego contar caracteres, no bytes; 80.053 bytes de «é» pasaban por 40.053',
    fichero: 'mcp/worker.mjs',
    // Reproduce el defecto tal como era. La primera versión de esta mutación contaba caracteres dentro
    // del lector acotado y rompía el ensamblado del buffer: la suite moría por un RangeError, no por W6.
    de: 'const text = await readBounded(request, MAX_BODY_BYTES);\n    if (text === null) return',
    a: 'const text = await request.text();\n    if (text.length > MAX_BODY_BYTES) return',
    rompe: 'W6',
  },
  {
    id: 'W-CLAVE-DEBIL',
    porque: 'una clave de acceso corta, adivinable, vuelve a abrir el servicio',
    fichero: 'mcp/worker.mjs',
    de: 'keys.some((k) => k.length < MIN_ACCESS_KEY_LENGTH)',
    a: 'false',
    rompe: 'W3',
  },
  {
    id: 'M-COLA',
    porque: 'la cola vuelve a no tener fondo y una ráfaga acumula promesas en memoria',
    fichero: 'mcp/protocol.mjs',
    de: 'if (wait > maxQueueMs) return false;',
    a: '',
    rompe: 'M10',
  },
  {
    id: 'M-TIEMPO',
    porque: 'una petición colgada vuelve a esperar sin fin',
    fichero: 'scripts/exact-core.mjs',
    de: 'params, signal: AbortSignal.timeout(timeoutMs),',
    a: 'params,',
    rompe: 'M10',
  },
  {
    id: 'M-EMAIL',
    porque: 'el email de contacto se cuela en el recibo',
    fichero: 'scripts/exact-core.mjs',
    de: 'api_key_used: Boolean(apiKey), email_used: Boolean(email),',
    a: 'api_key_used: Boolean(apiKey), email_used: Boolean(email), email,',
    rompe: 'M9',
  },
  {
    id: 'Q8-NOT',
    porque: 'una etiqueta sobre un grupo con NOT deja de vigilarse: sobrevivía en la segunda ronda de Codex',
    fichero: 'scripts/parse-filter.mjs',
    de: 'return /\\b(AND|OR|NOT)\\b|\\|/.test(inside);',
    a: 'return /\\b(AND|OR)\\b|\\|/.test(inside);',
    rompe: 'Q8',
  },
  {
    id: 'Q8-PROXIMIDAD',
    porque: 'la proximidad sobre una frase con comodín, o sin comillas, vuelve a pasar por verificada',
    fichero: 'scripts/parse-filter.mjs',
    de: "else if (modifier && modifier !== 'noexp' && !proximityPhraseOk(q, j)) add(raw, 'proximidad');",
    a: '',
    rompe: 'Q8',
  },
  {
    id: 'Q8-ASTERISCO-FRASE',
    porque: 'las frases vuelven a vaciarse antes de buscar asteriscos tipográficos, y "randomized trial∗" pasa',
    fichero: 'scripts/parse-filter.mjs',
    de: 'for (const m of String(query).matchAll(',
    a: "for (const m of String(query).replace(/[\"“][^\"”]*[\"”]/g, '\"\"').matchAll(",
    rompe: 'Q8',
  },
  {
    id: 'W-CLAVE-31',
    porque: 'el mínimo de la clave de acceso baja de 32 a 8: sobrevivía en la segunda ronda de Codex',
    fichero: 'mcp/worker.mjs',
    de: 'export const MIN_ACCESS_KEY_LENGTH = 32;',
    a: 'export const MIN_ACCESS_KEY_LENGTH = 8;',
    rompe: 'W3',
  },
  {
    id: 'M4',
    porque: 'un término descartado deja de invalidar el recuento cuando la consulta devuelve resultados',
    fichero: 'scripts/parse-filter.mjs',
    // Para que esto pruebe algo hay que vaciar `dropped`, no tocar uno de sus dos efectos. Medido el
    // 2026-09-30: `usable` lo invalidan por separado `dropped.length === 0` Y el `problems` que
    // empuja el aviso, así que quitar uno solo deja la suite en verde sin que la comprobación sea
    // mala — es un mutante EQUIVALENTE. Es defensa en profundidad, y conviene que se note.
    // Primera lección de esta puerta: dice de qué dudar, no dicta el veredicto.
    de: '  const dropped = [\n',
    a: '  const dropped = [];\n  const droppedIgnorado = [\n',
    rompe: 'Q6',
  },
  {
    id: 'M5',
    porque: 'una exclusión se compone con AND y PubMed la traduce como inclusión: el fallo original',
    fichero: 'scripts/parse-filter.mjs',
    de: 'export function compose(',
    a: 'export function compose(base, filter, negation) { return `(${base}) AND (${filter})`; }\nexport function composeViejo(',
    rompe: 'N3',
  },
  {
    id: 'R18-DECLARACION-VIEJA',
    porque: 'el router vuelve a declarar un término caído que el filtro ya no contiene: lo que pasó del 01/10 al 16/10',
    fichero: 'neurosymbolic_router.json',
    de: 'matched nothing.",\n        "cases": {}',
    a: 'matched nothing.",\n        "cases": {"filters/methodology/clinical_rules_ap.txt": ["\\"AUDIT rule\\"[tiab]"]}',
    rompe: 'R18',
  },
  {
    id: 'R19-SEGURIDAD-PACIENTE',
    porque: 'la ruta de seguridad farmacológica vuelve a abrir con el filtro de errores médicos, por el nombre de su clave',
    fichero: 'neurosymbolic_router.json',
    de: '"first_passes": [\n        "clinical.drug_adverse_events"\n      ],',
    a: '"first_passes": [\n        "clinical.drug_adverse_events",\n        "scope.safety_specific"\n      ],',
    rompe: 'R19',
  },
  {
    id: 'R20-PARENTESIS-SIN-COMILLAS',
    porque: 'vuelve el defecto real de 30 listas: `Rheumatology (Oxford)[JO]` sin comillas, que PubMed parte en un AND sobre todos los campos sin avisar',
    fichero: 'journal_filters_data.js',
    de: '|\\"Rheumatology (Oxford)\\"[JO]|',
    a: '|Rheumatology (Oxford)[JO]|',
    rompe: 'R20',
  },
  // Las cinco alteraciones con las que Codex mostró, el 2026-10-16, que C13/C14 comprobaban existencia y
  // longitud, no garantías. La de reading_depth ya la cubre C13-POLISEMIA. Son comprobaciones
  // estructurales: rechazan vacío y relleno, no prueban significado.
  {
    id: 'C13-RELLENO',
    porque: 'el significado de failed para coverage se sustituye por 41 letras x y C13 seguía pasando',
    fichero: 'neurosymbolic_router.json',
    de: '"coverage": "A coverage check found relevant records outside',
    a: '"coverage": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "coverage_original": "A coverage check found relevant records outside',
    rompe: 'C13',
  },
  {
    id: 'C14-SIN-ESTADO',
    porque: 'se borra qué significa cada estado de cobertura y C14 seguía pasando',
    fichero: 'neurosymbolic_router.json',
    de: '"status": "Recorded in provenance.operational_status under the coverage dimension.',
    a: '"status_retirado": "Recorded in provenance.operational_status under the coverage dimension.',
    rompe: 'C14',
  },
  {
    id: 'C14-SOLO-CORPUS',
    porque: 'la cobertura deja de ser obligatoria para informes y decisiones y solo queda para corpus',
    fichero: 'neurosymbolic_router.json',
    de: '      "a report, review, decision or publication rests on the result set",\n',
    a: '',
    rompe: 'C14',
  },
  {
    id: 'C14-METODO-VACIO',
    porque: 'el método de sensibilidad menos principal queda como cadena vacía y C14 seguía pasando',
    fichero: 'neurosymbolic_router.json',
    de: '"sensitivity_minus_main": "Build a broader query',
    a: '"sensitivity_minus_main": "", "metodo_retirado": "Build a broader query',
    rompe: 'C14',
  },
  {
    id: 'C14-SIN-RETROCESO',
    porque: 'una pasada específica que pierde perlas elegibles ya no manda retroceder: el hueco medido en desprescripción',
    fichero: 'neurosymbolic_router.json',
    de: '"if_pearls_lost": [\n      "specific_to_sensitive",',
    a: '"if_pearls_lost": [',
    rompe: 'C14',
  },
  {
    id: 'K5-SIN-REGISTRO',
    porque: 'la ejecución deja de registrar por qué se eligieron y descartaron los filtros',
    fichero: 'neurosymbolic_router.json',
    de: '"execution_engine",\n      "selection_record"\n    ],',
    a: '"execution_engine"\n    ],',
    rompe: 'K5',
  },
  {
    id: 'MCP-REGISTRO-SIEMPRE-DECLARADO',
    porque: 'el recibo da por coherente cualquier registro: un filtro descartado que sí se envió, o uno inventado, pasarían',
    fichero: 'mcp/protocol.mjs',
    de: "return { status: problems.length ? 'inconsistent' : 'declared', problems, notes };",
    a: "return { status: 'declared', problems, notes };",
    rompe: 'M18',
  },
  {
    id: 'MCP-REGISTRO-HORA-DE-EJECUCION',
    porque: 'la hora del registro deja de ser la de llegada y pasa a ser la de PubMed: ya no distingue un registro previo de uno posterior',
    fichero: 'mcp/protocol.mjs',
    // Con la hora del registro y su huella: desde la 1.14.0 el rechazo de la lectura también lleva
    // `received_at: receivedAt,` y va antes en el fichero; sin la segunda línea, se mutaba ese otro.
    de: 'received_at: receivedAt,\n          sha256: await sha256(recordText),',
    a: 'received_at: structured.executed_at,\n          sha256: await sha256(recordText),',
    rompe: 'M18',
  },
  {
    id: 'MCP-VENTANA-SIN-PASADA',
    porque: 'una ventana de fecha por política del agente vuelve a pasar sin la pasada del núcleo sin ella: el caso P (6 de 11)',
    fichero: 'mcp/protocol.mjs',
    de: 'if (!dw.unrestricted_pass_id) {',
    a: 'if (false) {',
    rompe: 'M18',
  },
  {
    id: 'MCP-AUTORREFERENCIA',
    porque: 'la pasada «sin ventana» puede ser la misma pasada con ventana: el contraejemplo de Codex del 2026-10-18',
    fichero: 'mcp/protocol.mjs',
    de: '} else if (dw.unrestricted_pass_id === thisPass) {',
    a: '} else if (false) {',
    rompe: 'M20',
  },
  {
    id: 'MCP-VENTANA-DE-FILTRO-LIBRE',
    porque: 'declarar la ventana como «de filtro» vuelve a eximir de la pasada sin fecha aunque no haya filtro con fecha',
    fichero: 'mcp/protocol.mjs',
    de: 'if (hasDateLimit(outside)) {',
    a: 'if (false) {',
    rompe: 'M20',
  },
  {
    id: 'MCP-ENVIADO-INEXISTENTE',
    porque: 'una ruta de filters_used que no existe desaparece antes del contraste y el registro sale declarado',
    fichero: 'mcp/protocol.mjs',
    de: 'else problems.push(`«${p}» va en filters_used y no está en el catálogo`);',
    a: 'else void 0;',
    rompe: 'M20',
  },
  {
    id: 'MCP-REGISTRO-FORMA-LIBRE',
    porque: 'el registro deja de validarse: claves ajenas, papeles u orígenes inventados llegarían al recibo como declarados',
    fichero: 'mcp/protocol.mjs',
    de: ': record !== undefined ? shapeError(record, SELECTION_RECORD_SCHEMA) : null;',
    a: ': null;',
    rompe: 'M19',
  },
  {
    id: 'K7-VENTANA-LIBRE',
    porque: 'adaptation vuelve a recortar a cinco años sin comparar con el núcleo sin ventana',
    fichero: 'neurosymbolic_router.json',
    de: '"use_current_5y_window_if_appropriate_with_date_window_check",',
    a: '"use_current_5y_window_if_appropriate",',
    rompe: 'K7',
  },
  {
    id: 'K7-PMID-SIN-ORIGEN',
    porque: 'el registro deja de admitir «origen indeterminado» y de nombrar el conocimiento previo: obligaría a inventar una fuente o a ocultarla',
    fichero: 'neurosymbolic_router.json',
    de: '| model_prior_knowledge | undetermined, detail}]',
    a: ', detail}]',
    rompe: 'K7',
  },
  {
    id: 'MCP-FIDELIDAD-CIEGA',
    porque: 'filter_fidelity da por presente cualquier filtro declarado: un filtro reconstruido de memoria pasaría como literal',
    fichero: 'mcp/protocol.mjs',
    de: 'if (positions.length === 0) {',
    a: 'if (false) {',
    rompe: 'M15',
  },
  {
    id: 'MCP-EXCLUSION-CON-AND',
    porque: 'una exclusión compuesta con AND deja de marcarse: la inversión silenciosa vuelve a pasar como fiel',
    fichero: 'mcp/protocol.mjs',
    de: 'if (bad.length) {',
    a: 'if (false && bad.length) {',
    rompe: 'M15',
  },
  // Los tres vectores de la revisión de Codex del 2026-10-16 sobre la Fase 1.
  {
    id: 'MCP-RUTA-HEREDADA',
    porque: 'vuelve a resolverse cualquier propiedad del objeto: __proto__ daba filter_fidelity verified a un filtro inexistente',
    fichero: 'mcp/protocol.mjs',
    de: "  if (!candidate || !known.has(candidate) || !Object.hasOwn(bundle.filters, candidate)) return null;",
    a: '  if (bundle.filters[p]) return p;\n  if (!candidate || !known.has(candidate) || !Object.hasOwn(bundle.filters, candidate)) return null;',
    rompe: 'M16',
  },
  {
    id: 'MCP-EXCLUSION-PRIMERA',
    porque: 'solo se mira la primera aparición: una exclusión bien compuesta tapa otra mal compuesta más adelante',
    fichero: 'mcp/protocol.mjs',
    de: 'for (let at = sent.indexOf(canonical); at !== -1; at = sent.indexOf(canonical, at + 1)) positions.push(at);',
    a: '{ const at = sent.indexOf(canonical); if (at !== -1) positions.push(at); }',
    rompe: 'M17',
  },
  {
    id: 'MCP-EXCLUSION-UN-PARENTESIS',
    porque: 'se salta como mucho un paréntesis: AND ((NOT X)) vuelve a pasar como fiel',
    fichero: 'mcp/protocol.mjs',
    de: "while (i >= 0 && (sent[i] === ' ' || sent[i] === '(')) i--;",
    a: "while (i >= 0 && sent[i] === ' ') i--; if (sent[i] === '(') i--; while (i >= 0 && sent[i] === ' ') i--;",
    rompe: 'M17',
  },
  {
    id: 'K6-P-SIN-ESPANA',
    porque: 'el control positivo pierde la restricción que define su población y conserva 11/11: la retención sola no lo ve',
    fichero: 'scripts/eval/cases.json',
    de: '"purpose": "Spain defines the population: core",\n            "topic": "child_obesity_prevalence",\n            "and": [\n              "filters/scope/spanish.txt"\n            ],',
    a: '"purpose": "Spain defines the population: core",\n            "topic": "child_obesity_prevalence",\n            "and": [],',
    rompe: 'K6',
  },
  {
    id: 'K1-CATALOGO-VIEJO',
    porque: 'el catálogo publicado deja de coincidir con los ficheros: una superficie descubriría un filtro que no existe',
    fichero: 'filters/catalog.json',
    de: '"path": "filters/scope/spanish.txt"',
    a: '"path": "filters/scope/spanish_viejo.txt"',
    rompe: 'K1',
  },
  {
    id: 'K2-SIN-PAPEL',
    porque: 'un filtro queda sin papel: se descubre, pero nadie dice cómo componerlo',
    fichero: 'neurosymbolic_router.json',
    de: '      "filters/scope/pediatrics.txt": "population_setting",\n',
    a: '',
    rompe: 'K2',
  },
  {
    id: 'K3-EXCLUSION-COMO-AMBITO',
    porque: 'un filtro que empieza por NOT pasa a declararse ámbito, y se compondría con AND: la inversión silenciosa',
    fichero: 'neurosymbolic_router.json',
    de: '"filters/scope/ocde.txt": "exclusion"',
    a: '"filters/scope/ocde.txt": "population_setting"',
    rompe: 'K3',
  },
  {
    id: 'K4-AMBITO-AND',
    porque: 'el ámbito vuelve a restringir el núcleo por defecto: el AND geográfico que perdía 24 de 26 ensayos',
    fichero: 'neurosymbolic_router.json',
    de: '"default_composition": "parallel_lane",\n        "how": "A parallel lane by default.',
    a: '"default_composition": "and",\n        "how": "A parallel lane by default.',
    rompe: 'K4',
  },
  {
    id: 'M6',
    porque: 'el parser vuelve a quedarse con una sola línea y trunca los filtros multilínea',
    fichero: 'scripts/parse-filter.mjs',
    de: '.join(\' \')',
    a: '.slice(0, 1).join(\' \')',
    rompe: 'P1',
  },
  // Orden y páginas (1.13.0): cada caso del criterio de hecho de la especificación 18- y de su adenda.
  {
    id: 'E-ORDEN-POR-DEFECTO',
    porque: 'se envía un orden por defecto en silencio: una llamada antigua cambiaría de lista sin pedirlo',
    fichero: 'scripts/exact-core.mjs',
    de: '...(sort ? { sort } : {}),',
    a: "sort: sort ?? 'relevance',",
    rompe: 'E10',
  },
  {
    id: 'E-ORDEN-LIBRE',
    porque: 'cualquier orden pasa al ejecutor: pub_date o una errata viajarían a NCBI',
    fichero: 'scripts/exact-core.mjs',
    de: 'if (sort !== undefined && !SORT_VALUES.includes(sort)) {',
    a: 'if (false) {',
    rompe: 'E10',
  },
  {
    id: 'E-RETSTART-LIBRE',
    porque: 'retstart deja de validarse: un offset negativo o fuera de la ventana llega a NCBI',
    fichero: 'scripts/exact-core.mjs',
    de: 'if (!Number.isSafeInteger(retstart) || retstart < 0 || retstart > ESEARCH_WINDOW - 1) {',
    a: 'if (false) {',
    rompe: 'E10',
  },
  {
    id: 'E-RETSTART-NO-VIAJA',
    porque: 'retstart se refleja en el recibo pero no viaja: todas las páginas serían la primera',
    fichero: 'scripts/exact-core.mjs',
    de: "...(retstart > 0 ? { retstart: String(retstart) } : {}), ",
    a: '',
    rompe: 'E10',
  },
  {
    id: 'E-SIN-ALIAS',
    porque: 'request.retmax desaparece del recibo: un consumidor de la 1.12 deja de encontrar lo que leía',
    fichero: 'scripts/exact-core.mjs',
    de: 'retstart, retmax, retmax_requested: retmax,',
    a: 'retstart, retmax_requested: retmax,',
    rompe: 'E10',
  },
  {
    id: 'E-SIN-ACOTAR',
    porque: 'una petición que cruza la ventana viaja sin acotar y se depende del recorte y del aviso de NCBI',
    fichero: 'scripts/exact-core.mjs',
    de: 'const retmaxSent = Math.min(retmax, ESEARCH_WINDOW - retstart);',
    a: 'const retmaxSent = retmax;',
    rompe: 'E11',
  },
  {
    id: 'E-ACOTA-LO-INVALIDO',
    porque: 'el acotado convierte en válido un retmax que no lo era: 10.000 desde 5.000 pasaría como 4.999',
    fichero: 'scripts/exact-core.mjs',
    de: 'if (!Number.isSafeInteger(retmax) || retmax < 0 || retmax > ESEARCH_WINDOW) {',
    a: 'if (!Number.isSafeInteger(retmax) || retmax < 0) {',
    rompe: 'E11',
  },
  {
    id: 'E-RECUENTO-COMO-PAGINA',
    porque: 'retmax 0 deja de ser un recuento y se presenta como página vacía: invita a un bucle',
    fichero: 'scripts/exact-core.mjs',
    de: "  if (retmaxRequested === 0) return stop('count_only');\n",
    a: '',
    rompe: 'E12',
  },
  {
    id: 'E-NO-VERIFICADO-CONTINUA',
    porque: 'una consulta rota ofrece página siguiente como si sus registros fueran el conjunto buscado',
    fichero: 'scripts/exact-core.mjs',
    de: "if (integrity !== 'verified' || count === null) return stop('not_verified');",
    a: "if (count === null) return stop('not_verified');",
    rompe: 'E12',
  },
  {
    id: 'E-PRIORIDAD-INVERTIDA',
    porque: 'un recuento de una consulta no verificable sale como count_only, es decir, como recuento válido',
    fichero: 'scripts/exact-core.mjs',
    de: "  if (integrity !== 'verified' || count === null) return stop('not_verified');\n  if (retmaxRequested === 0) return stop('count_only');",
    a: "  if (retmaxRequested === 0) return stop('count_only');\n  if (integrity !== 'verified' || count === null) return stop('not_verified');",
    rompe: 'E12',
  },
  {
    id: 'E-COMPLETO-EN-LA-ULTIMA',
    porque: 'records_complete pasa a verdadero en la última página de varias: una página se presentaría como el conjunto',
    fichero: 'scripts/exact-core.mjs',
    de: 'records_complete: retstart === 0 && count !== null && n === count,',
    a: 'records_complete: count !== null && retstart + n === count,',
    rompe: 'E13',
  },
  {
    id: 'E-VENTANA-CONTINUA',
    porque: 'al final de la ventana se ofrece un offset que ESearch no sirve: la siguiente llamada fallaría o daría un cero',
    fichero: 'scripts/exact-core.mjs',
    de: "  if (retstart + n > ESEARCH_WINDOW - 1) return stop('window_limit');\n",
    a: '',
    rompe: 'E14',
  },
  {
    id: 'E-VACIA-COMO-FIN',
    porque: 'una página vacía con registros por delante se trata como fin: se perdería el resto en silencio',
    fichero: 'scripts/exact-core.mjs',
    de: "  if (n === 0 && count > retstart) return stop('empty_page');\n",
    a: '',
    rompe: 'E15',
  },
  {
    id: 'E-PAGINA-1001-1000',
    porque: 'una lista vacía declara un tramo imposible (first > last) en vez de page null',
    fichero: 'scripts/exact-core.mjs',
    de: 'page: n > 0 ? { first: retstart + 1, last: retstart + n } : null,',
    a: 'page: { first: retstart + 1, last: retstart + n },',
    rompe: 'E15',
  },
  {
    id: 'E-SIN-AVANCE',
    porque: 'la continuación repite el offset de la página: un bucle que pide siempre la misma página',
    fichero: 'scripts/exact-core.mjs',
    de: 'return { next_retstart: retstart + n, next_retstart_reason: null };',
    a: 'return { next_retstart: retstart, next_retstart_reason: null };',
    rompe: 'E16',
  },
  {
    id: 'E-MOTIVO-INVENTADO',
    porque: 'la continuación normal lleva un motivo inventado en vez de null',
    fichero: 'scripts/exact-core.mjs',
    de: 'return { next_retstart: retstart + n, next_retstart_reason: null };',
    a: "return { next_retstart: retstart + n, next_retstart_reason: 'more' };",
    rompe: 'E16',
  },
  // Tres mutaciones aisladas, una por comparador (Codex, 2026-10-20): quitar los tres a la vez no probaba
  // que cada uno estuviera vigilado.
  {
    id: 'E-AJUSTE-SIN-POSICION',
    porque: 'NCBI dice haber servido otra posición con el tamaño pedido y se continúa desde la posición inferida',
    fichero: 'scripts/exact-core.mjs',
    de: '.some(([, s, c]) => Number(s) !== retstart || Number(c) !== retmaxSent);',
    a: '.some(([, s, c]) => Number(c) !== retmaxSent);',
    rompe: 'E17',
  },
  {
    id: 'E-AJUSTE-SIN-TAMANO',
    porque: 'NCBI dice haber servido otro tamaño en la posición pedida y se continúa como si no',
    fichero: 'scripts/exact-core.mjs',
    de: '.some(([, s, c]) => Number(s) !== retstart || Number(c) !== retmaxSent);',
    a: '.some(([, s]) => Number(s) !== retstart);',
    rompe: 'E17',
  },
  {
    id: 'E-LISTA-LARGA',
    porque: 'llegan más PMID de los pedidos y se continúa desde una posición que ya no corresponde',
    fichero: 'scripts/exact-core.mjs',
    de: "if (pageAdjusted(notices, retstart, retmaxSent) || n > retmaxSent) return stop('page_adjusted');",
    a: "if (pageAdjusted(notices, retstart, retmaxSent)) return stop('page_adjusted');",
    rompe: 'E17',
  },
  {
    id: 'U-AJUSTE-IGNORADO',
    porque: 'la unión acepta una página que NCBI sirvió en otra posición: borra la separación entre integridad de consulta y validez de página (R1)',
    fichero: 'scripts/page-union.mjs',
    de: 'if (pageAdjusted(p.pagination_notices, start, p.request?.retmax_sent)) {',
    a: 'if (false) {',
    rompe: 'U3',
  },
  {
    id: 'U-PLAN-OPCIONAL',
    porque: 'dos registros sin plan con la misma pasada se toman por un mismo recorrido (R2)',
    fichero: 'scripts/page-union.mjs',
    de: 'return rec?.plan_ref && rec?.pass?.pass_id ? JSON.stringify([rec.plan_ref, rec.pass.pass_id]) : null;',
    a: 'return rec?.pass?.pass_id ? JSON.stringify([rec.plan_ref, rec.pass.pass_id]) : null;',
    rompe: 'U1',
  },
  {
    id: 'U-CONCATENA',
    porque: 'el par se concatena con un separador: («a#b», «c») y («a», «b#c») colisionan (R2)',
    fichero: 'scripts/page-union.mjs',
    de: 'JSON.stringify([rec.plan_ref, rec.pass.pass_id])',
    a: '`${rec.plan_ref}#${rec.pass.pass_id}`',
    rompe: 'U1',
  },
  {
    id: 'MCP-RETSTART-NULO',
    porque: 'retstart: null pasa como 0 por la interfaz del MCP, aunque el esquema y el ejecutor solo admiten enteros',
    fichero: 'mcp/protocol.mjs',
    de: "const retstart = Object.hasOwn(args, 'retstart') ? args.retstart : 0;",
    a: 'const retstart = args.retstart ?? 0;',
    rompe: 'M21',
  },
  {
    id: 'U-SIN-CONTINUIDAD',
    porque: 'la unión deja de comprobar que cada página empieza donde acabó la anterior: un hueco pasaría',
    fichero: 'scripts/page-union.mjs',
    de: 'if (start !== expected) problems.push(',
    a: 'if (false) problems.push(',
    rompe: 'U1',
  },
  {
    id: 'U-PAGINA-CORTA',
    porque: 'una página corta antes del final se acepta por llamarse última: la omisión intermedia pasaría',
    fichero: 'scripts/page-union.mjs',
    de: 'if (n !== full) problems.push(',
    a: 'if (false) problems.push(',
    rompe: 'U1',
  },
  {
    id: 'U-SIN-RECORRIDO',
    porque: 'páginas sin recorrido declarado se funden porque sus parámetros coinciden',
    fichero: 'scripts/page-union.mjs',
    de: 'if (refs.has(null)) problems.push(',
    a: 'if (false) problems.push(',
    rompe: 'U1',
  },
  {
    id: 'U-COMPLETA',
    porque: 'la unión se llama completa: se atribuye a llamadas independientes la garantía de una instantánea',
    fichero: 'scripts/page-union.mjs',
    de: "status: ok ? OPERATIONAL : 'incomplete',",
    a: "status: ok ? 'complete' : 'incomplete',",
    rompe: 'U2',
  },
  {
    id: 'MCP-ORDEN-NO-PASA',
    porque: 'el MCP acepta sort y no lo entrega al ejecutor: el recibo diría orden por defecto con relevance pedido',
    fichero: 'mcp/protocol.mjs',
    de: '...(sort !== undefined ? { sort } : {}), ',
    a: '',
    rompe: 'M21',
  },
  {
    id: 'MCP-PAGINA-SIN-VALIDAR',
    porque: 'el MCP deja la validación de retstart y sort solo al ejecutor, fuera de su propia interfaz',
    fichero: 'mcp/protocol.mjs',
    de: ': pageInvalid ? pageInvalid',
    a: ': false ? pageInvalid',
    rompe: 'M21',
  },
  {
    id: 'MCP-FOCALIZADA-SIN-MOTIVO',
    porque: 'focused_selection pasa sin decir qué se leerá ni por qué: vuelve la muestra ordenada sin motivo',
    fichero: 'mcp/protocol.mjs',
    de: "else if (readingPath === 'focused_selection' && record.pass.selection_reason === undefined) {",
    a: 'else if (false) {',
    rompe: 'M22',
  },
  {
    id: 'MCP-NOTA-COMO-PROBLEMA',
    porque: 'un registro de la 1.12 sin reading_path pasa a inconsistent: la compatibilidad se rompe',
    fichero: 'mcp/protocol.mjs',
    de: "if (readingPath === undefined) notes.push('reading_path no declarado');",
    a: "if (readingPath === undefined) problems.push('reading_path no declarado');",
    rompe: 'M22',
  },
  {
    id: 'K8-SIN-SELECCION-FOCALIZADA',
    porque: 'desaparece la definición de focused_selection: el registro tendría un valor que el contrato no explica',
    fichero: 'neurosymbolic_router.json',
    de: '"focused_selection": "States which records will be read',
    a: '"focused_selection_retirada": "States which records will be read',
    rompe: 'K8',
  },
  {
    id: 'K8-CINCO-CONTROLES',
    porque: 'se cae un control de deriva: el de los duplicados y la unión igual al recuento',
    fichero: 'neurosymbolic_router.json',
    de: ',\n        "no PMID repeated across pages, and the union equal to result_count when the set fits in the window"',
    a: '',
    rompe: 'K8',
  },
  {
    id: 'K9-UNA-SOLA-CABEZA',
    porque: 'vuelve a bastar la cabeza de un orden: la revisión de 2026 quedaba 17.ª por relevancia con 15 leídos',
    fichero: 'neurosymbolic_router.json',
    de: 'read the head of the same query in both orders,',
    a: 'read the head of the same query,',
    rompe: 'K9',
  },
  {
    id: 'K9-GUIAS-CON-INTERVENCION',
    porque: 'la pasada de guías vuelve a exigir la intervención: la guía que no nombra el fármaco queda fuera',
    fichero: 'neurosymbolic_router.json',
    de: 'is searched at the level of the condition, without the intervention:',
    a: 'is searched with the core:',
    rompe: 'K9',
  },
  {
    id: 'K9-APLAZADA-COMO-HECHA',
    porque: 'una vía declarada fuera de PubMed vuelve a contar como hecha aunque su resultado no llegue',
    fichero: 'neurosymbolic_router.json',
    de: 'counts as not run until its result reaches the answer with its source.',
    a: 'counts as covered.',
    rompe: 'K9',
  },
  {
    id: 'K9-SIN-RECENCIA',
    porque: 'la recencia vuelve a ser una condición para seguir buscando que nada comprueba',
    fichero: 'neurosymbolic_router.json',
    de: '"recency_before_closing":',
    a: '"recency_before_closing_retirada":',
    rompe: 'K9',
  },
  // Lectura con recibo y dossier-check (1.14.0, especificación 29- y adenda de Codex del 24/10). Una por
  // control de §5: cada forma de dar por leído lo que no se leyó, o por medido lo que no se midió.
  {
    id: 'C12-EFETCH-FUERA',
    porque: 'un script vuelve a hablar con EFetch por su cuenta, fuera del único módulo que lo hace',
    fichero: 'scripts/fetch-core.mjs',
    de: "import { efetch, EFETCH_URL, EFETCH_TRANSPORT, FetchTransportError } from './efetch.mjs';",
    // La URL va partida aquí por lo mismo que en T1-FUERA: entera, C12 cazaría esta tabla.
    a: "import { efetch, EFETCH_URL, EFETCH_TRANSPORT, FetchTransportError } from './efetch.mjs';\n"
      + "export const efetchPropio = (ids) => fetch('https://eutils" + ".ncbi.nlm.nih.gov/entrez/eutils/efetch" + ".fcgi?id=' + ids);",
    rompe: 'C12',
  },
  {
    id: 'F1-CERO-IZQUIERDA',
    porque: 'un PMID con cero a la izquierda pasa: se pediría a NCBI un identificador corregido en silencio',
    fichero: 'scripts/fetch-core.mjs',
    de: 'export const PMID_PATTERN = /^[1-9][0-9]{0,8}$/;',
    a: 'export const PMID_PATTERN = /^[0-9]{1,9}$/;',
    rompe: 'F1',
  },
  {
    id: 'F2-GET',
    porque: 'la lectura viaja por GET con la lista en la URL, como el fallo que la 1.8.0 cerró para la búsqueda',
    fichero: 'scripts/efetch.mjs',
    de: 'response = await fetcher(EFETCH_URL, { method: EFETCH_TRANSPORT, body, ...(signal ? { signal } : {}) });',
    a: "response = await fetcher(`${EFETCH_URL}?${body}`, { method: 'GET' });",
    rompe: 'F2',
  },
  {
    id: 'F2-LISTA-RECORTADA',
    porque: 'se envía a NCBI otra lista que la pedida',
    fichero: 'scripts/efetch.mjs',
    de: "id: pmids.join(',')",
    a: "id: pmids.slice(0, 1).join(',')",
    rompe: 'F2',
  },
  {
    id: 'F2-CLAVE-EN-RECIBO',
    porque: 'la clave de NCBI acaba escrita en el recibo de lectura',
    fichero: 'scripts/fetch-core.mjs',
    de: 'api_key_used: Boolean(o.apiKey)',
    a: 'api_key_used: o.apiKey || false',
    rompe: 'F2',
  },
  {
    id: 'F3-POR-POSICION',
    porque: 'los registros se asocian por posición: si NCBI los reordena, cada PMID recibe el abstract de otro',
    fichero: 'scripts/fetch-core.mjs',
    de: '    else found.set(pmid, { el: c, supported });',
    a: '    else found.set(pmids[found.size], { el: c, supported });',
    rompe: 'F3',
  },
  {
    id: 'F3-ERROR-COMO-AUSENCIA',
    porque: 'un fallo de transporte se presenta como «no encontrado»: el disfraz que el contrato prohíbe',
    fichero: 'scripts/fetch-core.mjs',
    de: '    results: pmids.map((p) => errorRecord(p, code)),',
    a: '    results: pmids.map((p) => notFound(p)),',
    rompe: 'F3',
  },
  {
    id: 'F3-INCIERTO-COMO-AUSENCIA',
    porque: 'con un elemento desconocido sin PMID en la respuesta, un PMID que falta se da por no encontrado',
    fichero: 'scripts/fetch-core.mjs',
    de: '      results.set(pmid, unknownUnattributed.length',
    a: '      results.set(pmid, false',
    rompe: 'F3',
  },
  {
    id: 'F3-ESTADO-HTTP',
    porque: 'un 429 se lee como cuerpo y acaba en «XML inválido» en vez de en el fallo HTTP que es',
    fichero: 'scripts/efetch.mjs',
    de: '  if (response.status !== 200) {',
    a: '  if (response.status >= 500) {',
    rompe: 'F3',
  },
  {
    id: 'F4-UTF8-TOLERANTE',
    porque: 'un cuerpo con bytes UTF-8 inválidos se decodifica con sustituciones en vez de fallar',
    fichero: 'scripts/fetch-core.mjs',
    de: "text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);",
    a: "text = new TextDecoder('utf-8').decode(bytes);",
    rompe: 'F4',
  },
  {
    id: 'F4-SUPERINDICE',
    porque: 'un superíndice se aplana: m^(2) pasa a m2 y 1,73 m2 deja de ser una superficie',
    fichero: 'scripts/fetch-core.mjs',
    de: "    else if (c.name === 'sup') out += `^(${markupText(c, reason)})`;",
    a: "    else if (c.name === 'sup') out += markupText(c, reason);",
    rompe: 'F4',
  },
  {
    id: 'F4-SIN-OTHERABSTRACT',
    porque: 'los OtherAbstract (traducciones, resúmenes llanos) se descartan en silencio',
    fichero: 'scripts/fetch-core.mjs',
    de: "...childrenNamed(holder, 'OtherAbstract').map(",
    a: '...[].map(',
    rompe: 'F4',
  },
  {
    id: 'F4-FORMULA-SILENCIADA',
    porque: 'una fórmula MathML se convierte en su texto suelto y el abstract se da por completo',
    fichero: 'scripts/fetch-core.mjs',
    de: '    else throw new RecordError(reason, `<${c.name}> dentro de <${el.name}> no se puede representar sin pérdida`);',
    a: '    else out += markupText(c, reason);',
    rompe: 'F4',
  },
  {
    id: 'F4-ESPACIOS-COMO-ABSTRACT',
    porque: 'un abstract de solo espacios cuenta como abstract obtenido',
    fichero: 'scripts/abstract-canonical.mjs',
    de: 'blocks.some((b) => b.sections.some((s) => /\\S/.test(s.text)))',
    a: 'blocks.some((b) => b.sections.some((s) => s.text.length > 0))',
    rompe: 'F4',
  },
  {
    id: 'F4-ENTIDAD-SILENCIADA',
    porque: 'una entidad no definida se borra en vez de fallar: texto perdido sin aviso',
    fichero: 'scripts/xml-lite.mjs',
    de: '      throw new XmlError(`entidad no definida «&${clip(ref)};»: no se cargan DTD ni entidades externas`, at + amp);',
    a: "      out += '';",
    rompe: 'F4',
  },
  {
    id: 'F4-SUBCONJUNTO-INTERNO',
    porque: 'el DOCTYPE con subconjunto interno se salta en vez de rechazarse: podría declarar entidades',
    fichero: 'scripts/xml-lite.mjs',
    de: "    if (s[i] === '[') throw new XmlError('DOCTYPE con subconjunto interno: podría declarar entidades y no se admite', i);",
    a: "    if (s[i] === '[') { until(']', 'subconjunto'); space(); }",
    rompe: 'F4',
  },
  {
    id: 'F9-CIERRE-CRUZADO',
    porque: 'el analizador acepta etiquetas cruzadas: un árbol que el documento no describe',
    fichero: 'scripts/xml-lite.mjs',
    de: '      if (!top || top.name !== closing) throw',
    a: '      if (!top) throw',
    rompe: 'F9',
  },
  {
    id: 'F6-SIN-REGISTRO-GRANDE',
    porque: 'un registro que no cabe ni solo va a pendientes: se pediría otra vez, para siempre',
    fichero: 'scripts/fetch-core.mjs',
    de: '    if (alone > max) {',
    a: '    if (false) {',
    rompe: 'F6',
  },
  {
    id: 'F6-SIN-ORDEN-DE-ENTRADA',
    porque: 'se entrega todo y se quita del final: el pendiente deja de ser el que no cabía en su sitio',
    fichero: 'scripts/fetch-core.mjs',
    de: '    if (jsonBytes(build(new Set([...pending, ...content.slice(k + 1)]))) > max) {',
    a: '    if (false) {',
    rompe: 'F6',
  },
  {
    id: 'F6-CARACTERES-POR-BYTES',
    porque: 'el presupuesto cuenta caracteres y no bytes UTF-8: un texto multibyte lo desborda',
    fichero: 'scripts/fetch-core.mjs',
    de: 'const jsonBytes = (obj) => utf8Length(JSON.stringify(obj));',
    a: 'const jsonBytes = (obj) => JSON.stringify(obj).length;',
    rompe: 'F6',
  },
  {
    id: 'F6-PARCIAL-COMO-COMPLETA',
    porque: 'una entrega con pendientes o errores se declara complete',
    fichero: 'scripts/fetch-core.mjs',
    de: ": pending.length || results.some((r) => r.record_status === 'error') ? 'partial' : 'complete';",
    a: ": 'complete';",
    rompe: 'F6',
  },
  {
    id: 'F7-SIN-LIMITE-DE-CUERPO',
    porque: 'el cuerpo se lee entero aunque pase el límite: se mediría después, no durante la lectura',
    fichero: 'scripts/efetch.mjs',
    de: '      if (total > maxBytes) {',
    a: '      if (false) {',
    rompe: 'F7',
  },
  {
    id: 'F8-SIN-RUN',
    porque: 'el recibo de lectura deja de llevar el run del servidor',
    fichero: 'scripts/fetch-core.mjs',
    de: '    run: env.run,',
    a: '    run: null,',
    rompe: 'F8',
  },
  {
    id: 'MCP-LECTURA-COLA-PROPIA',
    porque: 'la lectura tiene su propia cola: búsqueda y lectura doblarían el ritmo real a NCBI',
    fichero: 'mcp/protocol.mjs',
    de: '    if (!(await throttle())) {\n      const busy',
    a: '    if (!(await makeThrottle(350, maxQueueMs)())) {\n      const busy',
    rompe: 'M26',
  },
  {
    id: 'MCP-LECTURA-CLAVES-LIBRES',
    porque: 'la herramienta de lectura admite claves ajenas, como un parámetro de continuación',
    fichero: 'mcp/protocol.mjs',
    de: '.filter((k) => !Object.hasOwn(FETCH_TOOL.inputSchema.properties, k));',
    a: '.filter(() => false);',
    rompe: 'M24',
  },
  {
    id: 'MCP-LECTURA-TEXTO-DISTINTO',
    porque: 'el texto del recibo de lectura deja de ser el JSON compacto que mide el presupuesto',
    fichero: 'mcp/protocol.mjs',
    de: "const compactResult = (structured, isError) => ({ content: [{ type: 'text', text: JSON.stringify(structured) }],",
    a: "const compactResult = (structured, isError) => ({ content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],",
    rompe: 'M25',
  },
  {
    id: 'W9-SELLO-SIN-LECTURA',
    porque: 'el sello del despliegue deja fuera los ficheros de la lectura: su código no quedaría identificado',
    fichero: 'mcp/stamp.mjs',
    de: "'scripts/xml-lite.mjs', 'scripts/abstract-canonical.mjs'];",
    a: '];',
    rompe: 'W9',
  },
  {
    id: 'X2-SIN-HUELLA-DE-ABSTRACT',
    porque: 'el comprobador no recalcula la huella del abstract: una huella declarada basta',
    fichero: 'scripts/dossier-check.mjs',
    de: '      if (await sha256(x.abstract_canonical) !== x.abstract_sha256) problems.push',
    a: '      if (false) problems.push',
    rompe: 'X2',
  },
  {
    id: 'X2-SIN-LONGITUD',
    porque: 'el comprobador no recalcula la longitud UTF-8 del abstract',
    fichero: 'scripts/dossier-check.mjs',
    de: '      if (utf8Length(x.abstract_canonical) !== x.abstract_bytes) problems.push',
    a: '      if (false) problems.push',
    rompe: 'X2',
  },
  {
    id: 'X2-SIN-FORMA-CANONICA',
    porque: 'una cadena no canónica con su huella recalculada pasa por abstract íntegro',
    fichero: 'scripts/abstract-canonical.mjs',
    de: '  if (problems.length === 0 && JSON.stringify(blocks) !== canonical) {',
    a: '  if (false) {',
    rompe: 'X2',
  },
  {
    id: 'X4-CIERRE-POR-ETIQUETA',
    porque: 'el perfil bench da por cerrada la captura sin evidencia: la etiqueta aprueba',
    fichero: 'scripts/dossier-check.mjs',
    de: "  let inventory = 'unknown';",
    a: "  let inventory = manifest.profile === 'bench' ? 'closed' : 'unknown';",
    rompe: 'X4',
  },
  {
    id: 'X4-OMISION-TOLERADA',
    porque: 'una llamada registrada por la captura y ausente del inventario no impide el cierre',
    fichero: 'scripts/dossier-check.mjs',
    de: '        } else if (missingInLog.length || missingInInventory.length) {',
    a: '        } else if (missingInLog.length) {',
    rompe: 'X4',
  },
  {
    id: 'X4-COPIA-CUENTA-DOS',
    porque: 'dos copias del mismo intento cuentan como dos intentos',
    fichero: 'scripts/dossier-check.mjs',
    de: '    if (prior) {',
    a: '    if (false) {',
    rompe: 'X4',
  },
  {
    id: 'X5-SIN-HUELLA-DE-ARCHIVO',
    porque: 'un archivo con otra huella que la declarada se usa igual',
    fichero: 'scripts/dossier-check.mjs',
    de: "    const status = bytes === null ? 'missing' : actual !== ref.sha256 ? 'hash_mismatch' : 'ok';",
    a: "    const status = bytes === null ? 'missing' : 'ok';",
    rompe: 'X5',
  },
  {
    id: 'X5-SIN-HUELLA-DE-LISTA',
    porque: 'una lista de PMID retocada pasa si el archivo se volvió a sellar',
    fichero: 'scripts/dossier-check.mjs',
    de: "  if (await sha256(r.pmids.join('\\n')) !== r.pmid_list_sha256) d.push(",
    a: '  if (false) d.push(',
    rompe: 'X5',
  },
  {
    id: 'X5-D1-ELIGE',
    porque: 'con recuentos distintos entre páginas, D1 elige uno en vez de declarar conflicto',
    fichero: 'scripts/dossier-check.mjs',
    de: "        status: conflicts.length || distinct.length > 1 ? 'conflict'",
    a: "        status: conflicts.length ? 'conflict'",
    rompe: 'X5',
  },
  {
    id: 'X5-FALLIDA-CUENTA',
    porque: 'una lista con integridad fallida entra en los PMID devueltos válidos',
    fichero: 'scripts/dossier-check.mjs',
    de: "    if (p.status.query_integrity !== 'verified') {",
    a: '    if (false) {',
    rompe: 'X5',
  },
  {
    id: 'X5-UNION-SIN-DEFECTO',
    porque: 'una recuperación declarada completa que no pasa la unión no es un defecto',
    fichero: 'scripts/dossier-check.mjs',
    de: '      if (union.status !== OPERATIONAL) defect(',
    a: '      if (false) defect(',
    rompe: 'X5',
  },
  {
    id: 'X6-LECTURA-SIN-RESOLVER',
    porque: 'un pendiente o un error de lectura que nunca se resolvió no impide el veredicto',
    fichero: 'scripts/dossier-check.mjs',
    de: "  if (unresolved.length) defect('reading_incomplete'",
    a: "  if (false) defect('reading_incomplete'",
    rompe: 'X6',
  },
  {
    id: 'X6-SIN-PARTICION',
    porque: 'un PMID pedido puede desaparecer del recibo sin ser resultado ni pendiente',
    fichero: 'scripts/dossier-check.mjs',
    de: 'if (all.length !== pmids.length || new Set(all).size !== all.length || !all.every((p) => pmids.includes(p))',
    a: 'if (false',
    rompe: 'X6',
  },
  {
    id: 'X7-ORDEN-SIN-COTA',
    porque: 'sin cota de reloj justificada se infiere orden igualmente',
    fichero: 'scripts/dossier-check.mjs',
    de: '  if (clock.bound === null || [a.start, a.end, b.start, b.end].some((t) => !Number.isFinite(t))) return',
    a: '  if ([a.start, a.end, b.start, b.end].some((t) => !Number.isFinite(t))) return',
    rompe: 'X7',
  },
  {
    id: 'X7-SIN-TOLERANCIA',
    porque: 'una separación menor que la cota de desfase se toma como orden',
    fichero: 'scripts/dossier-check.mjs',
    de: "  if (a.end + clock.bound < b.start) return 'before';",
    a: "  if (a.end < b.start) return 'before';",
    rompe: 'X7',
  },
  {
    id: 'X7-POSTERIOR-SUBSANA',
    porque: 'una declaración hecha después de la primera lectura cuenta como previa',
    fichero: 'scripts/dossier-check.mjs',
    de: "        return each.every((x) => x === 'before') ? 'before'",
    a: "        return each.some((x) => x === 'before') ? 'before'",
    rompe: 'X7',
  },
  {
    id: 'X8-MENCION-COMO-USO',
    porque: 'sin citas ni registro de uso, D4 se da por medido con las menciones',
    fichero: 'scripts/dossier-check.mjs',
    de: '  const d4Measured = responseText !== null && useSources.length > 0 && !(accredited.length === 0 && unverifiedUses.length > 0);',
    a: '  const d4Measured = responseText !== null;',
    rompe: 'X8',
  },
  {
    id: 'X8-SIN-ANCLA',
    porque: 'un uso declarado cuenta aunque su fragmento no esté en la respuesta',
    fichero: 'scripts/dossier-check.mjs',
    de: '    const anchored = hasOffsets ? responseText.slice(u.start, u.end) === u.fragment : responseText.includes(u.fragment);',
    a: '    const anchored = true;',
    rompe: 'X8',
  },
  {
    id: 'X8-IDENTIDAD-SUPUESTA',
    porque: 'PMID y DOI se funden sin correspondencia explícita: D4 cuenta menos documentos de los que hay',
    fichero: 'scripts/dossier-check.mjs',
    de: '    const root = find(sourceKey(u.source));',
    a: "    const root = u.source.type === 'url' ? sourceKey(u.source) : 'pubmed';",
    rompe: 'X8',
  },
  {
    id: 'X1-CONOCIDOS-COMO-DEVUELTOS',
    porque: 'los known_pmids entran en los PMID devueltos: amplían la cobertura de la consulta',
    fichero: 'scripts/dossier-check.mjs',
    de: '  const S = sortPmids(validLists.flatMap((l) => l.receipt.pmids));',
    a: '  const S = sortPmids([...validLists.flatMap((l) => l.receipt.pmids), ...declarations.map((d) => d.pmid)]);',
    rompe: 'X1',
  },
  {
    id: 'X9-REFERENCIA-VACIA-AL-CIEN',
    porque: 'con la referencia vacía, la retención sale 100 % en vez de null',
    fichero: 'scripts/dossier-check.mjs',
    de: 'ratio: R.length ? hits.length / R.length : null,',
    a: 'ratio: R.length ? hits.length / R.length : 1,',
    rompe: 'X9',
  },
  // Revisión de Codex del código 1.14 (25/10, R1-R9): una por control nuevo, sobre el caso en que solo
  // ese control falla.
  {
    id: 'X11-SIN-FORMA',
    porque: 'los recibos se usan sin validar su forma: sin procedencia aprueban y un resultado null tumba el comprobador',
    fichero: 'scripts/dossier-check.mjs',
    de: "const shape = entry.kind === 'search' ? searchShapeErrors(payload) : entry.kind === 'fetch' ? fetchShapeErrors(payload)\n      : entry.kind === 'fetch_rejected' ? rejectionShapeErrors(payload) : [];",
    a: 'const shape = [];',
    rompe: 'X11',
  },
  {
    id: 'X11-SIN-CONTINUACION',
    porque: 'una continuación que el ejecutor no daría para esa página pasa sin recalcularla',
    fichero: 'scripts/dossier-check.mjs',
    de: '  if (next.next_retstart !== r.next_retstart || next.next_retstart_reason !== r.next_retstart_reason) {',
    a: '  if (false) {',
    rompe: 'X11',
  },
  {
    id: 'X11-SIN-COMPLETITUD',
    porque: 'records_complete no se contrasta con recuento y lista',
    fichero: 'scripts/dossier-check.mjs',
    de: '  if (r.records_complete !== (start === 0 && count !== null && n === count)) d.push(',
    a: '  if (false) d.push(',
    rompe: 'X11',
  },
  {
    id: 'X12-IDENTIDAD-NO-FILTRA',
    porque: 'un abstract íntegro con otro returned_pmid sigue sumando D3',
    fichero: 'scripts/dossier-check.mjs',
    de: "      if (['with_abstract', 'without_abstract', 'not_found'].includes(outcome) && !attributable.has(pmid)) outcome = 'not_attributable';",
    a: '',
    rompe: 'X12',
  },
  {
    id: 'X12-RECIBO-FALLIDO-ACREDITA',
    porque: 'un recibo con identidad o entrega fallidas acredita sus registros',
    fichero: 'scripts/dossier-check.mjs',
    de: "  const receiptTrusted = d.length === 0 && identity !== 'failed' && delivery !== 'failed';",
    a: '  const receiptTrusted = true;',
    rompe: 'X12',
  },
  {
    id: 'X13-SIN-RESPUESTA-OLVIDADA',
    porque: 'una lectura sin respuesta con su petición conservada desaparece de lo que hay que resolver',
    fichero: 'scripts/dossier-check.mjs',
    de: '        if (a.request) unanswered.push(',
    a: '        if (false) unanswered.push(',
    rompe: 'X13',
  },
  {
    id: 'X13-SIN-PETICION-TOLERADA',
    porque: 'una lectura sin respuesta ni petición no impide aprobar',
    fichero: 'scripts/dossier-check.mjs',
    de: "        else uncertain('reading_without_response'",
    a: "        else if (false) uncertain('reading_without_response'",
    rompe: 'X13',
  },
  {
    id: 'X14-CONFLICTO-SIN-DEFECTO',
    porque: 'recuentos distintos entre páginas no impiden aprobar si otra pasada mide D1',
    fichero: 'scripts/dossier-check.mjs',
    de: "    if (distinct.length > 1) defect('count_conflict'",
    a: "    if (false) defect('count_conflict'",
    rompe: 'X14',
  },
  {
    id: 'X15-HUELLA-SOLA',
    porque: 'una referencia de uso se resuelve por la huella sola, sin comprobar de qué PMID es',
    fichero: 'scripts/dossier-check.mjs',
    de: '!abstractRefs.has(tuple(ref.pmid, ref.abstract_sha256))',
    a: '![...abstractRefs].some((k) => JSON.parse(k)[1] === ref.abstract_sha256)',
    rompe: 'X15',
  },
  {
    id: 'X16-SIN-ANCLA-COMO-CERO',
    porque: 'usos declarados sin ninguna ancla se presentan como cero usos medidos',
    fichero: 'scripts/dossier-check.mjs',
    de: ' && !(accredited.length === 0 && unverifiedUses.length > 0);',
    a: ';',
    rompe: 'X16',
  },
  {
    id: 'X16-PARCIAL-APRUEBA',
    porque: 'un D4 con usos sin ancla junto a otros acreditados aprueba',
    fichero: 'scripts/dossier-check.mjs',
    de: "  } else if (unverifiedUses.length) {\n    uncertain('d4_partial'",
    a: "  } else if (false) {\n    uncertain('d4_partial'",
    rompe: 'X16',
  },
  // Revisión de Codex del delta (25/10, Δ1-Δ3).
  {
    id: 'X17-AUSENCIA-SIN-TRANSPORTE',
    porque: 'una ausencia o un registro sin abstract se acreditan con HTTP 500 o sin huella de la respuesta',
    fichero: 'scripts/dossier-check.mjs',
    de: "    r.results.some((x) => ['with_abstract', 'without_abstract', 'not_found'].includes(x.record_status))",
    a: "    r.results.some((x) => x.record_status === 'with_abstract')",
    rompe: 'X17',
  },
  {
    id: 'X18-VACIA-FUERA-DE-RECUENTO',
    porque: 'una página vacía pedida tras el final se trata como una página que sobrepasa el recuento',
    fichero: 'scripts/dossier-check.mjs',
    de: '  if (count !== null && n > 0 && start + n > count) d.push(',
    a: '  if (count !== null && start + n > count) d.push(',
    rompe: 'X18',
  },
  {
    id: 'X19-RECHAZO-SIN-FORMA',
    porque: 'un objeto marcado como rechazo previo a NCBI se admite sin run, intento, hora ni motivo',
    fichero: 'scripts/dossier-check.mjs',
    de: "      : entry.kind === 'fetch_rejected' ? rejectionShapeErrors(payload) : [];",
    a: '      : [];',
    rompe: 'X19',
  },
  {
    id: 'F10-CARACTERES-LIBRES',
    porque: 'un carácter que XML no admite (un nulo literal) se entrega como texto',
    fichero: 'scripts/xml-lite.mjs',
    de: '  if (bad) throw new XmlError(`carácter no admitido',
    a: '  if (false) throw new XmlError(`carácter no admitido',
    rompe: 'F10',
  },
  {
    id: 'F10-DECLARACION-SALTADA',
    porque: 'la declaración XML se salta hasta «?>» sin comprobarla',
    fichero: 'scripts/xml-lite.mjs',
    de: "    const decl = XML_DECL.exec(s);\n    if (!decl) throw new XmlError('declaración XML mal formada', i);",
    a: "    const decl = XML_DECL.exec(s) ?? [s.slice(0, s.indexOf('?>') + 2)];",
    rompe: 'F10',
  },
  {
    id: 'F11-ERROR-COMO-REGISTRO',
    porque: 'un <ERROR> de NCBI dentro del conjunto se trata como un registro desconocido más',
    fichero: 'scripts/fetch-core.mjs',
    de: '  if (ncbiErrors.length) {',
    a: '  if (false) {',
    rompe: 'F11',
  },
  {
    id: 'F12-DIAGNOSTICO-SIN-ACOTAR',
    porque: 'un nombre de elemento enorme entra entero en el diagnóstico del registro y rompe el presupuesto',
    fichero: 'scripts/fetch-core.mjs',
    de: '    this.detail = clip(detail, MAX_DIAGNOSTIC);',
    a: '    this.detail = detail;',
    rompe: 'F12',
  },
];

// ---------------------------------------------------------------------------------------------

const arbolSucio = () => {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
  } catch {
    return null; // sin git disponible: no se puede comprobar, se dice más abajo
  }
};

const fallosDe = (salida) => [...salida.matchAll(/^\s*(?:FAIL|fail)\s+(\S+)/gm)].map((m) => m[1]);

// Las suites: la de conformidad, la del MCP y, desde la 1.14.0, la de lectura y dossier. La puerta solo
// corría la primera, así que una mutación del Worker o del protocolo no podía caer nunca (lo dejó ver la
// revisión de Codex).
const SUITES = [['scripts', 'validate-router.mjs'], ['mcp', 'test.mjs'], ['scripts', 'validate-reading.mjs']];
const correrSuite = () => {
  let status = 0;
  let salida = '';
  for (const ruta of SUITES) {
    const r = spawnSync(process.execPath, [join(RAIZ, ...ruta)], { cwd: RAIZ, encoding: 'utf8' });
    if (r.status !== 0) status = r.status ?? 1;
    salida += `${r.stdout ?? ''}${r.stderr ?? ''}`;
  }
  return { status, salida };
};

// DÓNDE SE MUTA, y por qué no siempre aquí.
//
// En CI el checkout es desechable: mutar en sitio no puede llevarse nada de nadie. En una máquina de
// trabajo no. `finally` no protege de un corte abrupto ni de otra escritura entre la comprobación y
// la restauración, y el árbol es el del usuario. Lo señaló Codex el 2026-09-30. Así que fuera de CI
// se trabaja sobre un `git worktree` desechable y el árbol compartido no se toca nunca.
//
// Y si git no se puede comprobar, se ABORTA. Antes continuaba «con restauración en finally», que es
// confiar la seguridad justo a lo que no basta.
const EN_CI = Boolean(process.env.CI);
let RAIZ = ROOT;
let worktree = null;

const sucio = arbolSucio();
if (sucio === null) {
  console.error('ABORTA: no se pudo comprobar el estado de git.');
  console.error('Esta puerta muta ficheros, y sin git no hay forma de saber qué había antes ni de');
  console.error('trabajar sobre una copia desechable. No se continúa a ciegas.');
  process.exit(2);
}
if (sucio === true && EN_CI) {
  console.error('ABORTA: el árbol tiene cambios sin guardar y en CI se muta en sitio.');
  process.exit(1);
}
if (!EN_CI) {
  worktree = join(tmpdir(), `pubmed-filters-mutaciones-${process.pid}`);
  try {
    execFileSync('git', ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD'],
      { cwd: ROOT, encoding: 'utf8' });
    RAIZ = worktree;
    console.log(`copia desechable: ${worktree}`);
    if (sucio) console.log('aviso: tu árbol tiene cambios sin guardar; la copia sale de HEAD, no de ellos.');
    console.log('');
  } catch (err) {
    console.error(`ABORTA: no se pudo crear la copia desechable (${String(err.message).split('\n')[0]}).`);
    process.exit(2);
  }
}
const limpiarCopia = () => {
  if (!worktree) return;
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: ROOT, encoding: 'utf8' });
  } catch { /* si quedara, `git worktree prune` lo recoge */ }
};
process.on('exit', limpiarCopia);

// Línea base: sin mutar, la suite tiene que estar en verde. Si no, lo que viene después no significa
// nada —una mutación «detectada» sobre un banco ya roto no prueba absolutamente nada—.
const base = correrSuite();
if (base.status !== 0) {
  console.error('ABORTA: la suite ya falla SIN mutar. Arregla eso antes: sobre un banco roto, una');
  console.error('mutación «detectada» no demuestra nada.');
  console.error(base.salida.split('\n').filter((l) => /fail/i.test(l)).join('\n'));
  process.exit(1);
}
console.log('base  la suite sin mutar está en verde\n');

const pass = [];
const fallo = [];

for (const m of MUTACIONES) {
  const ruta = join(RAIZ, m.fichero);
  const original = readFileSync(ruta, 'utf8');
  if (!original.includes(m.de)) {
    fallo.push(`${m.id}  la mutación NO se puede aplicar: «${m.de.slice(0, 40)}» no está en ${m.fichero}`
      + ' — la tabla se ha quedado vieja respecto al código, y una mutación que no muta no prueba nada');
    continue;
  }
  const mutado = original.replace(m.de, m.a);
  if (mutado === original) {
    fallo.push(`${m.id}  la mutación no cambia el fichero: no prueba nada`);
    continue;
  }
  try {
    writeFileSync(ruta, mutado);
    const { status, salida } = correrSuite();
    const caidas = fallosDe(salida);
    if (status === 0) {
      fallo.push(`${m.id}  SOBREVIVE: ${m.porque} — la suite sigue en verde, así que ${m.rompe} es decorativa`);
    } else if (!caidas.includes(m.rompe)) {
      fallo.push(`${m.id}  rompe la suite pero NO ${m.rompe} (cayeron: ${caidas.join(', ') || 'ninguna nombrada'})`
        + ` — ${m.rompe} no vigila lo que dice vigilar`);
    } else {
      pass.push(`${m.id}  ${m.rompe} la detecta · ${m.porque}`);
    }
  } finally {
    writeFileSync(ruta, original);
    const restaurado = readFileSync(ruta, 'utf8');
    if (restaurado !== original) {
      console.error(`\nATENCIÓN: ${m.fichero} no quedó igual que estaba. Revísalo con git diff antes de seguir.`);
      process.exit(1);
    }
  }
}

for (const p of pass) console.log(`  pass  ${p}`);
for (const f of fallo) console.log(`  FAIL  ${f}`);
console.log(`\n${pass.length} mutaciones detectadas / ${fallo.length} sin detectar`);
if (arbolSucio() === true) {
  console.error('ATENCIÓN: el árbol quedó sucio al terminar. Revisa git diff: la restauración falló.');
  process.exit(1);
}
process.exit(fallo.length === 0 ? 0 : 1);
