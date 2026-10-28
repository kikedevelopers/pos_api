import { createHash, timingSafeEqual } from 'node:crypto';

import type { WompiEvent } from '../wompi/wompi.types';

/**
 * Verificación de la firma de los eventos de Wompi.
 *
 * Algoritmo (docs.wompi.co → Eventos): se toman, EN ORDEN, los valores de las
 * rutas de `signature.properties` dentro de `data`; se concatenan, se les
 * agrega `timestamp` y el secreto de eventos, y se calcula SHA-256. El
 * resultado tiene que coincidir con `signature.checksum` (o el header
 * `X-Event-Checksum`).
 *
 * Las propiedades se leen DEL EVENTO, no se fijan aquí: Wompi avisa que la
 * lista puede cambiar.
 */

/** Lee `transaction.amount_in_cents` dentro de `data`. `undefined` si la ruta no existe. */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Checksum esperado para un evento. `null` si al evento le falta algo para firmarse. */
export function computeEventChecksum(event: WompiEvent, eventsSecret: string): string | null {
  const properties = event?.signature?.properties;
  const timestamp = event?.timestamp;
  if (!Array.isArray(properties) || properties.length === 0) {
    return null;
  }
  if (typeof timestamp !== 'number' && typeof timestamp !== 'string') {
    return null;
  }
  if (!eventsSecret) {
    return null;
  }

  let concatenated = '';
  for (const property of properties) {
    if (typeof property !== 'string') {
      return null;
    }
    const value = readPath(event.data, property);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return null;
    }
    concatenated += String(value);
  }
  concatenated += String(timestamp) + eventsSecret;

  return createHash('sha256').update(concatenated).digest('hex');
}

/**
 * `true` solo si la firma del evento es auténtica. Compara en tiempo constante
 * y acepta el checksum del cuerpo o el del header (si vienen los dos, ambos
 * tienen que coincidir).
 */
export function verifyEventSignature(
  event: WompiEvent,
  eventsSecret: string,
  headerChecksum?: string | null,
): boolean {
  const expected = computeEventChecksum(event, eventsSecret);
  if (!expected) {
    return false;
  }

  const bodyChecksum =
    typeof event.signature?.checksum === 'string' ? event.signature.checksum : null;
  const provided = [bodyChecksum, headerChecksum?.trim() || null].filter(
    (value): value is string => value !== null,
  );
  if (provided.length === 0) {
    return false;
  }

  return provided.every((checksum) => safeEqualHex(expected, checksum.toLowerCase()));
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
