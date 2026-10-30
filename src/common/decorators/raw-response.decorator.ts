import { SetMetadata } from '@nestjs/common';

/** Clave de metadata para marcar respuestas que NO deben envolverse. */
export const RAW_RESPONSE_KEY = 'raw_response';

/**
 * Marca un handler o controller para que el `ResponseWrapperInterceptor` NO
 * envuelva su respuesta en `{ success, payload }` y la devuelva CRUDA.
 *
 * Necesario para endpoints cuyo cuerpo lo consume un tercero con un formato
 * exacto, no el frontend de PlacePos. Ejemplo: el reto de verificación del
 * webhook de WhatsApp (Meta), que exige recibir el `hub.challenge` tal cual,
 * en texto plano.
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
