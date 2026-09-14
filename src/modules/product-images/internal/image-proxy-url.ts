import { createHmac, timingSafeEqual } from 'crypto';

/**
 * URLs firmadas PROPIAS para servir las imágenes del inventario por proxy a
 * través de pos_api, en vez de URLs firmadas de GCS.
 *
 * Por qué existe: firmar una URL v4 de GCS con ADC (la identidad de la VM, sin
 * clave privada) obliga a llamar a la API `iam.signBlob` de Google, que en el
 * proyecto de despliegue está deshabilitada y no se puede habilitar sin tocar
 * GCP. Aquí firmamos NOSOTROS con HMAC-SHA256 y un secreto del servidor: la URL
 * apunta a un endpoint de pos_api que descarga el objeto (permiso de LECTURA,
 * que la SA ya tiene) y hace stream de los bytes. No se firma nada en Google.
 *
 * El modelo de seguridad es el mismo que una URL firmada: una URL-capacidad,
 * acotada en el tiempo (`exp`) y a un objeto concreto (`objectName`), imposible
 * de forjar sin el secreto. El `objectName` lleva embebido el `company_id`
 * (`inventory_items/<company_id>/...`), así que la firma también impide pedir la
 * imagen de otro tenant.
 */

/** Contexto fijo del HMAC: evita que una firma sirva para otro propósito. */
const HMAC_CONTEXT = 'product-image-proxy:v1';

/** Por qué falló una verificación (para logs/diagnóstico; nunca al cliente). */
export type ImageTokenFailure = 'malformed' | 'bad_signature' | 'expired';

export interface ImageTokenVerification {
  ok: boolean;
  reason?: ImageTokenFailure;
}

/** Firma `objectName` + `exp` con el secreto. base64url para que viaje en la URL. */
export function signImageObject(objectName: string, expiresAtMs: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${HMAC_CONTEXT}\n${objectName}\n${expiresAtMs}`)
    .digest('base64url');
}

/**
 * Ruta RELATIVA del proxy. El front le antepone la base del API que ya conoce
 * (no se hardcodea el dominio público en el servidor). `o` = objeto, `e` =
 * expiración (ms epoch), `s` = firma.
 */
export function buildImageProxyPath(
  objectName: string,
  expiresAtMs: number,
  signature: string,
): string {
  const params = new URLSearchParams({
    o: objectName,
    e: String(expiresAtMs),
    s: signature,
  });
  return `/product-images/serve?${params.toString()}`;
}

/**
 * Verifica una URL firmada: primero la firma (comparación en tiempo constante),
 * luego la expiración. Comprobar la firma antes evita que se pueda sondear la
 * validez de `exp` sin un token legítimo.
 */
export function verifyImageObject(params: {
  objectName: string;
  expiresAtMs: number;
  signature: string;
  secret: string;
  nowMs: number;
}): ImageTokenVerification {
  const { objectName, expiresAtMs, signature, secret, nowMs } = params;

  if (!objectName || !signature || !Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = signImageObject(objectName, expiresAtMs, secret);
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (expiresAtMs < nowMs) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true };
}
