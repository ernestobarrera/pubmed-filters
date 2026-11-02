#!/usr/bin/env node
/**
 * Audita una ejecución hecha desde una superficie conversacional (ChatGPT, claude.ai) a partir del archivo
 * de recibos que conservó el propio modelo: un JSONL con una línea `{ tool, request, response }` por llamada.
 *
 *   node scripts/audit-surface.mjs recibos.jsonl [--respuesta respuesta.md] [--perlas perlas.json] [--salida carpeta]
 *
 * Convierte el archivo en un dossier (manifiesto, un fichero por recibo, respuesta y referencia), lo pasa
 * por dossier-check.mjs y escribe en la carpeta de salida `dossier-check.json` e `informe.md`. Sale con el
 * código del comprobador: 0 consistent, 1 incomplete, 2 inconclusive.
 *
 * Local y sin red. No rehace búsquedas ni lecturas, no rellena lo que falta y no interpreta clínicamente.
 * Lo archivó el modelo: sin un registro de cierre externo, una superficie no pasa de `inconclusive`, porque
 * nada prueba que el archivo tenga todas las llamadas. Los planes admitidos son los que declaran los propios
 * recibos. Las perlas (`--perlas`) son una referencia de retención: una lista de PMID o un
 * `pubmed-dossier-reference`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDossier, FORMATS, LIMITS, safePath } from './dossier-check.mjs';
import { sha256Bytes, PMID_PATTERN, FETCH_RECEIPT_TYPE } from './fetch-core.mjs';
import { SUMMARY_RECEIPT_TYPE } from './summary-core.mjs';

export const AUDITOR_VERSION = '1.0.0';
const DOSSIER_TOOLS = ['pubmed_search_exact', 'pubmed_fetch_exact', 'pubmed_summary_exact'];
const CONTEXT_TOOLS = ['pubmed_filter_catalog', 'pubmed_get_filter'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const enc = (s) => new TextEncoder().encode(s);
const payloadOf = (response) => (isObj(response) && isObj(response.structuredContent) ? response.structuredContent : null);

/** La herramienta de una línea que solo trae la respuesta, deducida de la forma de su recibo. */
function inferTool(p) {
  if (!isObj(p)) return null;
  if (p.receipt_type === FETCH_RECEIPT_TYPE) return 'pubmed_fetch_exact';
  if (p.receipt_type === SUMMARY_RECEIPT_TYPE) return 'pubmed_summary_exact';
  if (typeof p.sent_query_sha256 === 'string' || ('result_count' in p && typeof p.error === 'string')) return 'pubmed_search_exact';
  if (Array.isArray(p.filters) && isObj(p.counts)) return 'pubmed_filter_catalog';
  if (typeof p.path === 'string' && 'how_to_compose' in p) return 'pubmed_get_filter';
  return null;
}

/** La referencia de perlas, en cualquiera de sus dos formas, como `pubmed-dossier-reference`. */
export function referenceFromPerlas(json) {
  if (Array.isArray(json)) {
    return { format: FORMATS.reference, format_version: 1, reference_id: 'perlas', version: null, source: 'perlas declaradas por quien audita',
      partial: true, target_pmids: json, synthesis_pmids: [] };
  }
  if (isObj(json) && json.format === FORMATS.reference) return json;
  if (isObj(json) && Array.isArray(json.target_pmids)) {
    return { format: FORMATS.reference, format_version: 1, reference_id: json.reference_id ?? 'perlas', version: json.version ?? null,
      source: json.source ?? 'perlas declaradas por quien audita', partial: json.partial !== false, target_pmids: json.target_pmids,
      synthesis_pmids: json.synthesis_pmids ?? [] };
  }
  return null;
}

/**
 * Del archivo de la superficie a un dossier en memoria: `files` (ruta → bytes) y `manifest`. Además devuelve
 * las llamadas de contexto (catálogo y filtro), las líneas ilegibles y las peticiones archivadas que no
 * coinciden con lo que acredita su recibo.
 */
export async function buildSurfaceDossier(jsonlText, { responseBytes = null, perlas = null } = {}) {
  const files = new Map();
  const put = async (path, bytes) => { files.set(path, bytes); return { file: path, sha256: await sha256Bytes(bytes) }; };
  const unreadable = [];
  const contextCalls = [];
  const requestMismatches = [];
  const responseOnly = [];
  const attempts = [];
  const plans = new Map();
  const admit = (plan, pass) => {
    if (typeof plan !== 'string' || !plan.trim()) return;
    const set = plans.get(plan) ?? plans.set(plan, new Set()).get(plan);
    if (typeof pass === 'string' && pass.trim()) set.add(pass);
  };
  const lines = jsonlText.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    if (!raw.trim()) continue;
    const at = `L${i + 1}`;
    let line;
    try { line = JSON.parse(raw); } catch { unreadable.push({ line: i + 1, reason: 'no es JSON' }); continue; }
    // Dos formas: { tool, request, response } o la respuesta sola, { structuredContent, content }.
    if (isObj(line) && line.tool === undefined && isObj(line.structuredContent)) {
      const tool = inferTool(line.structuredContent);
      if (!tool) { unreadable.push({ line: i + 1, reason: 'respuesta sin forma de recibo reconocible' }); continue; }
      line = { tool, response: line };
      responseOnly.push(i + 1);
    }
    if (!isObj(line) || typeof line.tool !== 'string' || !isObj(line.response)) { unreadable.push({ line: i + 1, reason: 'sin { tool, response }' }); continue; }
    const p = payloadOf(line.response);
    if (CONTEXT_TOOLS.includes(line.tool)) {
      contextCalls.push({ line: i + 1, tool: line.tool, request: line.request ?? null,
        contract_version: p?.contract_version ?? p?.run?.contract_version ?? null, path: p?.path ?? null });
      continue;
    }
    const tool = DOSSIER_TOOLS.includes(line.tool) ? line.tool : 'other';
    if (p && line.request !== undefined) {
      const asked = tool === 'pubmed_search_exact' ? line.request?.query : line.request?.pmids;
      const certified = tool === 'pubmed_search_exact' ? p.sent_query : p.request?.pmids;
      if (tool !== 'other' && asked !== undefined && certified !== undefined && JSON.stringify(asked) !== JSON.stringify(certified)) {
        requestMismatches.push({ line: i + 1, tool });
      }
    }
    if (tool === 'pubmed_search_exact') admit(p?.selection_record?.record?.plan_ref, p?.selection_record?.record?.pass?.pass_id);
    else if (tool !== 'other') admit(p?.request?.context?.plan_ref, null);
    const ref = await put(`intentos/${String(i + 1).padStart(3, '0')}.json`, enc(JSON.stringify(line.response)));
    attempts.push({ attempt_ref: at, tool, external_id: typeof p?.attempt_id === 'string' ? p.attempt_id : null, ...ref, captured: 'transcribed' });
  }
  const manifest = {
    format: FORMATS.manifest, format_version: 1, dossier_id: `surface:${(await sha256Bytes(enc(jsonlText))).slice(0, 16)}`,
    case: null, condition: 'surface', profile: 'surface',
    capture: { method: 'surface_jsonl', inventory_by: 'model', closure: null, clock: null },
    plans: plans.size ? [...plans].map(([plan_ref, passes]) => ({ plan_ref, passes: [...passes].sort() })) : [{ plan_ref: 'sin-plan', passes: [] }],
    attempts,
  };
  if (responseBytes) manifest.response = { ...await put('respuesta.md', responseBytes), captured: 'transcribed' };
  let referenceError = null;
  if (perlas !== null) {
    const ref = referenceFromPerlas(perlas);
    if (!ref) referenceError = 'perlas: ni lista de PMID ni pubmed-dossier-reference';
    else if (!ref.target_pmids.every((x) => typeof x === 'string' && PMID_PATTERN.test(x))) referenceError = 'perlas: algún PMID no es válido';
    else manifest.reference = await put('referencia.json', enc(JSON.stringify(ref)));
  }
  return { files, manifest, contextCalls, unreadable, requestMismatches, responseOnly, referenceError };
}

const list = (xs, max = 40) => (xs.length ? `${xs.slice(0, max).join(', ')}${xs.length > max ? ` y ${xs.length - max} más` : ''}` : 'ninguno');
const num = (v) => (v === null || v === undefined ? '—' : String(v));

/** Informe legible, por niveles de garantía, de lo que dice el comprobador. */
export function renderReport(result, { source, built }) {
  const r = result;
  const out = [];
  const by = (tool) => r.attempts?.filter((a) => a.tool === tool).length ?? 0;
  const findingsOf = (code) => r.findings.find((f) => f.code === code)?.pmids ?? [];
  out.push('# Auditoría de superficie', '');
  out.push(`- **Material:** \`${source.name}\` · ${source.bytes} bytes · SHA-256 \`${source.sha256}\` · ${source.lines} líneas.`);
  const contracts = [...new Set(built.contracts)].sort();
  out.push(`- **Contrato en los recibos:** ${contracts.length ? contracts.join(', ') : 'no consta'}.`);
  out.push(`- **Comprobador:** dossier-check ${r.checker.version}, auditor ${AUDITOR_VERSION}.`);
  out.push(`- **Veredicto:** \`${r.verdict}\`: ${r.meaning}. Una superficie sin registro externo de cierre no pasa de \`inconclusive\`: el archivo lo hizo el modelo.`, '');

  out.push('## G1 · Integridad de las llamadas (comprobado por código)', '');
  out.push(`- **Llamadas archivadas:** ${by('pubmed_search_exact')} búsquedas, ${by('pubmed_summary_exact')} cribados, ${by('pubmed_fetch_exact')} lecturas,`
    + ` ${built.contextCalls.length} de catálogo o filtro y ${by('other')} de otras herramientas.`);
  if (built.unreadable.length) out.push(`- **Líneas ilegibles:** ${built.unreadable.map((u) => `${u.line} (${u.reason})`).join(', ')}.`);
  const compared = built.responseOnly.length ? ` (${built.responseOnly.length} líneas traen solo la respuesta: herramienta deducida del recibo y petición sin comparar)` : '';
  out.push(`- **Petición archivada frente a la acreditada por su recibo:** ${built.requestMismatches.length
    ? `distinta en las líneas ${built.requestMismatches.map((m) => m.line).join(', ')}` : 'coinciden todas las comparables'}${compared}.`);
  const failed = r.exclusions.filter((x) => /integridad|búsqueda fallida/.test(x.reason));
  out.push(`- **Búsquedas excluidas por integridad:** ${failed.length ? failed.map((x) => `${x.attempt_ref} (${x.reason})`).join('; ') : 'ninguna'}.`);
  out.push(`- **Defectos del material:** ${r.defects.length ? '' : 'ninguno.'}`);
  for (const d of r.defects.slice(0, 30)) out.push(`  - \`${d.code}\`: ${d.detail}`);
  if (r.defects.length > 30) out.push(`  - y ${r.defects.length - 30} más en dossier-check.json`);
  if (r.defects.some((d) => d.code === 'abstract_gap' && /abstract_sha256 no coincide/.test(d.detail))) {
    out.push('', 'Una huella declarada que no coincide con el texto archivado suele indicar que quien archivó normalizó caracteres:'
      + ' espacios especiales, comillas o saltos de línea. Releer esos PMID distingue la normalización de una alteración del contenido.'
      + ' Mientras tanto, esos abstracts no cuentan como íntegros.');
  }
  out.push('');

  const D = r.denominators ?? {};
  out.push('## G2 · Integridad de lo recuperado (comprobado por código)', '');
  out.push(`- **PMID únicos devueltos (D2):** ${num(D.D2?.value)}, en ${num(D.D2?.raw_appearances)} apariciones.`);
  out.push(`- **Títulos cribados:** ${num(D.titles_screened?.value)}. No son lecturas. Fuera de toda lista: ${list(D.titles_screened?.outside_returned ?? [])}. Pendientes sin resolver: ${list(D.titles_screened?.pending_unresolved ?? [])}.`);
  out.push(`- **Abstracts íntegros conservados (D3):** ${num(D.D3?.value)} de ${num(D.D3?.requested_unique)} PMID pedidos. Sin abstract: ${list(D.D3?.without_abstract ?? [])}.`
    + ' Cada abstract se ha comprobado contra su huella y su forma canónica.');
  out.push('');

  out.push('## Embudo por pasada (medido sobre lo conservado)', '');
  out.push('| Pasada | Encontrados | Devueltos | Cribados | Leídos | Usados |', '|---|---:|---:|---:|---:|---:|');
  for (const p of r.passes ?? []) {
    const f = p.funnel;
    const failedOnly = p.attempts_valid.length === 0 && p.attempts_failed.length > 0;
    out.push(`| ${p.pass_id ?? '¿?'}${p.walk_id ? ` (${p.walk_id})` : ''}${failedOnly ? ' (fallida)' : ''} | ${num(f.found)} | ${f.returned} | ${f.screened} | ${f.abstracts_obtained} | ${num(f.used)} |`);
  }
  out.push('', 'Encontrados es el recuento de PubMed para la pasada. Los demás números son PMID de su lista devuelta. «Usados» exige citas resueltas o un registro de uso: sin él, no se mide.', '');

  out.push('## Procedencia: de identificado a leído', '');
  out.push(`- **Leídos sin pasada de origen ni declaración en \`known_pmids\`:** ${list(findingsOf('read_without_origin'))}.`);
  out.push(`- **Cribados sin pasada de origen:** ${list(findingsOf('screened_without_origin'))}.`);
  out.push(`- **Mencionados en la respuesta sin abstract conservado:** ${r.dossier && built.hasResponse ? list(findingsOf('mentioned_without_reading')) : 'sin respuesta aportada'}.`);
  out.push('', 'Un PMID leído sin procedencia puede venir de la web, de una búsqueda no archivada o del conocimiento del modelo: el material no permite saber cuál.', '');

  if (r.retention?.status === 'measured') {
    const st = (name) => r.retention.stages.find((s) => s.stage === name);
    out.push('## Perlas', '');
    for (const name of ['returned', 'abstracts_preserved']) {
      const s = st(name);
      out.push(`- **${name === 'returned' ? 'En alguna lista devuelta' : 'Con abstract conservado'}:** ${s.numerator} de ${s.denominator}. Faltan: ${list(s.missing)}.`);
    }
    if (Array.isArray(r.retention.within_query)) {
      for (const w of r.retention.within_query) out.push(`- **Dentro del conjunto de ${w.pass_id}:** ${w.numerator} de ${w.denominator} (${w.via}).`);
    } else {
      out.push('- **Dentro del conjunto entero de cada pasada:** no medido. Una perla que falta puede estar fuera de la cabecera traída o fuera de la estrategia.');
    }
    out.push('');
  } else if (built.referenceError) out.push('## Perlas', '', `- ${built.referenceError}.`, '');

  out.push('## Lo que este informe no acredita', '');
  out.push('- G3 (calidad de la estrategia), G5 (validez de la síntesis) y G6 (aplicabilidad): fuera de lo que comprueba el código. Las perlas solo dan una medida parcial de G3 y G4.');
  out.push('- El registro de selección, el propósito de cada pasada y lo que se apartó en el cribado son declaraciones del agente, no hechos comprobados.');
  for (const l of LIMITS) out.push(`- ${l}`);
  out.push('');
  if (r.uncertainties.length || r.notices.length) {
    out.push('## Incertidumbres y avisos', '');
    for (const u of r.uncertainties) out.push(`- \`${u.code}\`: ${u.detail}`);
    for (const n of r.notices.slice(0, 20)) out.push(`- ${n}`);
    if (r.notices.length > 20) out.push(`- y ${r.notices.length - 20} avisos más en dossier-check.json`);
    out.push('');
  }
  return out.join('\n');
}

/** Todo el recorrido en memoria: dossier, comprobación e informe. */
export async function auditSurface(jsonlText, { responseBytes = null, perlas = null, name = 'recibos.jsonl' } = {}) {
  const built = await buildSurfaceDossier(jsonlText, { responseBytes, perlas });
  const result = await checkDossier(built.manifest, async (p) => (safePath(p) ? built.files.get(p) ?? null : null));
  const contracts = [];
  for (const [path, bytes] of built.files) {
    if (!path.startsWith('intentos/')) continue;
    const p = payloadOf(JSON.parse(new TextDecoder().decode(bytes)));
    if (typeof p?.run?.contract_version === 'string') contracts.push(p.run.contract_version);
  }
  const bytes = enc(jsonlText);
  const source = { name, bytes: bytes.length, sha256: await sha256Bytes(bytes), lines: jsonlText.split(/\r?\n/).filter((l) => l.trim()).length };
  const report = renderReport(result, { source, built: { ...built, contracts, hasResponse: Boolean(responseBytes) } });
  return { built, result, report };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const file = args.find((a, i) => !a.startsWith('--') && !['--respuesta', '--perlas', '--salida'].includes(args[i - 1]));
  if (!file) {
    console.error('Uso: node scripts/audit-surface.mjs recibos.jsonl [--respuesta respuesta.md] [--perlas perlas.json] [--salida carpeta]');
    process.exit(2);
  }
  let jsonlText;
  let responseBytes = null;
  let perlas = null;
  try {
    jsonlText = readFileSync(file, 'utf8');
    if (opt('--respuesta')) responseBytes = new Uint8Array(readFileSync(opt('--respuesta')));
    if (opt('--perlas')) perlas = JSON.parse(readFileSync(opt('--perlas'), 'utf8'));
  } catch (e) {
    console.error(`No se puede leer la entrada: ${e.message}`);
    process.exit(2);
  }
  const { built, result, report } = await auditSurface(jsonlText, { responseBytes, perlas, name: basename(file) });
  const out = resolve(opt('--salida') ?? join(dirname(resolve(file)), `${basename(file).replace(/\.jsonl$/i, '')}.auditoria`));
  mkdirSync(out, { recursive: true });
  for (const [p, bytes] of built.files) {
    const target = join(out, ...p.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(join(out, 'manifiesto.json'), `${JSON.stringify(built.manifest, null, 2)}\n`);
  writeFileSync(join(out, 'dossier-check.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(out, 'informe.md'), `${report}\n`);
  console.log(`${result.verdict} · ${result.defects.length} defectos · ${result.findings.length} hallazgos · ${out}`);
  process.exitCode = result.exit_code;
}
