/**
 * La única forma en que este repositorio llama a ESearch.
 *
 * La consulta viaja en el cuerpo, por POST (query_execution_contract.transport_carries_the_whole_query).
 * Un tema real con un filtro metodológico compuesto en línea no cabe en una URL: por GET, E-utilities
 * responde HTTP 414. Y ese 414 no es un cero ni un «no evaluable»: es un fallo de transporte declarado.
 *
 * `fetcher` es inyectable para que la suite observe la petición que de verdad se entrega —método,
 * dónde va `term` y si llega íntegro—, no el texto del código que la construye.
 */

export const ESEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
export const TRANSPORT = 'POST';

export class TransportError extends Error {
  constructor(status) {
    super(`FALLO_DE_TRANSPORTE: HTTP ${status}. La consulta no llegó entera a PubMed; `
      + 'no es un cero ni un resultado vacío.');
    this.status = status;
  }
}

/**
 * Ejecuta ESearch y devuelve { transport, esearchresult, raw }. `term` nunca puede sobrescribirse.
 *
 * `raw` es el cuerpo tal como llegó, antes de parsearlo: su SHA-256 es la instantánea de la ejecución
 * (provenance.execution_snapshot_rule). Un hash del JSON re-serializado sería el hash de lo que este
 * código entendió, no de lo que PubMed respondió. Un cuerpo que no es JSON lanza: no es un cero.
 */
export async function esearch(term, { params = {}, fetcher = fetch, signal } = {}) {
  const body = new URLSearchParams({ db: 'pubmed', retmode: 'json', ...params, term });
  const response = await fetcher(ESEARCH_URL, { method: TRANSPORT, body, ...(signal ? { signal } : {}) });
  if (response.status === 413 || response.status === 414) throw new TransportError(response.status);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // PubMed devuelve así algunos de sus propios errores: medido el 2026-10-08, el ERROR de retstart
    // fuera de ventana trae un salto de línea crudo dentro de la cadena y no es JSON válido. Un
    // adaptador que caiga a 0 aquí fabrica un cero falso; esto lanza con el mensaje legible.
    const fatal = /"ERROR"\s*:\s*"([\s\S]*?)"\s*[,}]/.exec(raw)?.[1];
    throw new Error(`RESPUESTA_ILEGIBLE: PubMed no devolvió JSON válido${
      fatal ? ` (ERROR: ${fatal.replace(/\s+/g, ' ')})` : ''}. No es un cero ni un resultado vacío.`);
  }
  return { transport: TRANSPORT, esearchresult: payload?.esearchresult, raw };
}
