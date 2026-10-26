/**
 * La única forma en que este repositorio llama a EFetch (especificación 29-, §3.2). Hermano de
 * `esearch.mjs`: lo que aquí no se mide, el recibo no lo puede declarar.
 *
 * Una petición por llamada: `db=pubmed`, `retmode=xml` y la lista exacta en `id`, por POST. Sin ESearch
 * auxiliar, sin historial y sin parámetros libres: quien llama no puede cambiar la base, el formato ni la
 * lista. El cuerpo se lee contando BYTES (ya descomprimidos) y se corta al pasar el límite: un prefijo
 * nunca se entrega como respuesta completa. `fetcher` es inyectable para que las pruebas vean la
 * petición entregada, no el código que la construye.
 */

export const EFETCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
export const EFETCH_TRANSPORT = 'POST';

/**
 * Un fallo antes de tener un cuerpo completo. `code`: `http_status`, `timeout`, `network` o
 * `response_too_large`. Nunca lleva la clave ni el contacto: el mensaje sale de aquí, no de NCBI.
 */
export class FetchTransportError extends Error {
  constructor(code, message, { httpStatus = null, bytesReceived = null } = {}) {
    super(`FALLO_DE_TRANSPORTE (${code}): ${message}. No es una ausencia de abstracts ni un resultado vacío.`);
    this.code = code;
    this.httpStatus = httpStatus;
    this.bytesReceived = bytesReceived;
  }
}

const abortError = (signal) => new FetchTransportError(signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'network',
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
        throw new FetchTransportError('response_too_large', `el cuerpo supera ${maxBytes} bytes`, { bytesReceived: total });
      }
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    if (e instanceof FetchTransportError) throw e;
    throw new FetchTransportError('network', 'lectura del cuerpo interrumpida', { bytesReceived: total });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return bytes;
}

/**
 * Ejecuta EFetch y devuelve `{ httpStatus, bytes }` con el cuerpo completo, o lanza FetchTransportError.
 * `params` solo puede añadir `tool`, `email` y `api_key`: lo fijo va después y no se sobrescribe.
 */
export async function efetch(pmids, { params = {}, fetcher = fetch, signal, maxBytes }) {
  const body = new URLSearchParams({ ...params, db: 'pubmed', retmode: 'xml', id: pmids.join(',') });
  let response;
  try {
    response = await fetcher(EFETCH_URL, { method: EFETCH_TRANSPORT, body, ...(signal ? { signal } : {}) });
  } catch {
    if (signal?.aborted) throw abortError(signal);
    throw new FetchTransportError('network', 'no se obtuvo respuesta de NCBI');
  }
  if (response.status !== 200) {
    response.body?.cancel().catch(() => {});
    throw new FetchTransportError('http_status', `HTTP ${response.status}`, { httpStatus: response.status });
  }
  return { httpStatus: response.status, bytes: await readBounded(response, maxBytes, signal) };
}
