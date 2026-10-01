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
    id: 'T1-GET',
    porque: 'la consulta vuelve a viajar por GET, con term en la URL: el fallo que la 1.8.0 cerro',
    fichero: 'scripts/esearch.mjs',
    // Reproduce el defecto COMO SERIA: un GET de verdad, con la consulta en la query string. La
    // primera version solo cambiaba `method` y dejaba el cuerpo, que ningun regreso real a GET
    // escribiria —y que `fetch` ni siquiera acepta—. Caia T1 igual, porque la suite usa un fetcher
    // de prueba y veia el metodo entregado; pero una mutacion debe parecerse al fallo que vigila,
    // no bastarle con tumbar la comprobacion. Lo senalo Codex el 2026-10-01.
    de: 'const response = await fetcher(ESEARCH_URL, { method: TRANSPORT, body });',
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
    id: 'M6',
    porque: 'el parser vuelve a quedarse con una sola línea y trunca los filtros multilínea',
    fichero: 'scripts/parse-filter.mjs',
    de: '.join(\' \')',
    a: '.slice(0, 1).join(\' \')',
    rompe: 'P1',
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

const correrSuite = () => {
  const r = spawnSync(process.execPath, [join(RAIZ, 'scripts', 'validate-router.mjs')],
    { cwd: RAIZ, encoding: 'utf8' });
  return { status: r.status, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
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
