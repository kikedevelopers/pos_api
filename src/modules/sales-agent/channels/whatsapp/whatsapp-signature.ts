import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifica la firma del webhook de WhatsApp (Meta). Meta firma el cuerpo CRUDO
 * con HMAC-SHA256 usando el secreto de la app y lo manda en el header
 * `X-Hub-Signature-256: sha256=<hex>`.
 *
 * Se compara contra el HMAC del MISMO cuerpo crudo (no el reserializado, que
 * podría diferir en espacios/orden). En tiempo constante.
 *
 * Devuelve `false` si falta el secreto, el header o no coincide — nunca lanza.
 */
export function verifyWhatsappSignature(
  rawBody: Buffer | string | undefined,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!appSecret || !signatureHeader || rawBody === undefined) {
    return false;
  }

  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  if (!provided) return false;

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', appSecret).update(body).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided.toLowerCase(), 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}
