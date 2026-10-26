/**
 * La única forma en que este repositorio llama a ESummary (diseño 33-, §4 b). Hermano de `esearch.mjs`
 * y `efetch.mjs`: lo que aquí no se mide, el recibo no lo puede declarar.
 *
 * Una petición por llamada: `db=pubmed`, `retmode=json`, `version=2.0` y la lista exacta en `id`, por
 * POST. Sin historial ni parámetros libres: quien llama no puede cambiar la base, el formato ni la lista.
 * El cuerpo se lee contando BYTES (ya descomprimidos) y se corta al pasar el límite: un prefijo nunca se
 * entrega como respuesta completa. `fetcher` es inyectable para que las pruebas vean la petición
 * entregada, no el código que la construye.
 *
 * La lectura acotada es la de `efetch.mjs`, copiada a propósito: cada servicio vive en su módulo y un
 * cambio en uno no mueve la huella del otro (diseño 33-, §4 b: «no toca nada de lo existente»).
 */

export const ESUMMARY_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
export const ESUMMARY_TRANSPORT = 'POST';

/**
 * Un fallo antes de tener un cuerpo completo. `code`: `http_status`, `timeout`, `network` o
 * `response_too_large`. Nunca lleva la clave ni el contacto: el mensaje sale de aquí, no de NCBI.
 */
export class SummaryTransportError extends Error {
  constructor(code, message, { httpStatus = null, bytesReceived = null } = {}) {
    super(`FALLO_DE_TRANSPORTE (${code}): ${message}. No es una ausencia de registros ni un resultado vacío.`);
    this.code = code;
    this.httpStatus = httpStatus;
    this.bytesReceived = bytesReceived;
  }
}

const abortError = (signal) => new SummaryTransportError(signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'network',
  signal?.reason?.name === 'TimeoutError' ? 'tiempo agotado' : 'petición cancelada');

/** Lee el cuerpo por tramos hasta `maxBytes`; respeta la señal también durante la lectura. */
async function readBounded(response, maxBytes, signal) {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {}); // si nadie la espera ya, que no quede un rechazo sin atender
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new SummaryTransportError('response_too_large', `el cuerpo supera ${maxBytes} bytes`, { bytesReceived: total });
      }
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    if (e instanceof SummaryTransportError) throw e;
    throw new SummaryTransportError('network', 'lectura del cuerpo interrumpida', { bytesReceived: total });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return bytes;
}

/**
 * Ejecuta ESummary y devuelve `{ httpStatus, bytes }` con el cuerpo completo, o lanza SummaryTransportError.
 * `params` solo puede añadir `tool`, `email` y `api_key`: lo fijo va después y no se sobrescribe.
 */
export async function esummary(pmids, { params = {}, fetcher = fetch, signal, maxBytes }) {
  const body = new URLSearchParams({ ...params, db: 'pubmed', retmode: 'json', version: '2.0', id: pmids.join(',') });
  let response;
  try {
    response = await fetcher(ESUMMARY_URL, { method: ESUMMARY_TRANSPORT, body, ...(signal ? { signal } : {}) });
  } catch {
    if (signal?.aborted) throw abortError(signal);
    throw new SummaryTransportError('network', 'no se obtuvo respuesta de NCBI');
  }
  if (response.status !== 200) {
    response.body?.cancel().catch(() => {});
    throw new SummaryTransportError('http_status', `HTTP ${response.status}`, { httpStatus: response.status });
  }
  return { httpStatus: response.status, bytes: await readBounded(response, maxBytes, signal) };
}
