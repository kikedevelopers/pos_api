/**
 * Traducción de fallos de la API de Gemini a mensajes que un tendero entiende.
 * Puro y testeado: es lo único que el usuario final ve cuando algo sale mal.
 */

const extractApiMessage = (rawBody: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const error = (parsed as { error?: unknown }).error;
    if (!error || typeof error !== 'object') {
      return null;
    }
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && message.trim().length > 0 ? message.trim() : null;
  } catch {
    return null;
  }
};

/** Detalle técnico útil para el log, nunca para el usuario. */
export const extractApiErrorDetail = (rawBody: string): string =>
  extractApiMessage(rawBody) ?? rawBody.slice(0, 500);

/**
 * Mensaje de cara al usuario para un status HTTP de la API generativa.
 * `rawBody` es el cuerpo crudo de la respuesta (puede venir vacío).
 */
export const describeHttpFailure = (status: number, rawBody = ''): string => {
  const apiMessage = extractApiMessage(rawBody) ?? '';
  const lower = apiMessage.toLowerCase();

  if (status === 400) {
    if (lower.includes('api key') || lower.includes('api_key')) {
      return 'La llave de la IA no es válida. Revisa la configuración del servidor (GEMINI_API_KEY).';
    }
    return 'La solicitud a la IA fue rechazada por ser inválida. Reformula tu mensaje e intenta de nuevo.';
  }

  if (status === 401 || status === 403) {
    return 'El servidor no tiene permiso para usar la IA. Verifica la llave y los permisos del proyecto de Google.';
  }

  if (status === 404) {
    // Un 404 REAL de modelo siempre trae explicación ("models/x is not found
    // for API version..."). Un 404 con cuerpo VACÍO no dice nada del modelo:
    // Google lo devuelve de forma intermitente cuando el proyecto está sin
    // cuota/créditos (la misma llamada responde 429 al reintentar). Culpar a
    // `GEMINI_DEFAULT_MODEL` en ese caso manda al operador a buscar donde no es.
    if (apiMessage.length === 0) {
      return 'El servicio de IA rechazó la solicitud sin dar detalle. Suele ser un problema temporal o de cuota del proyecto de Google: intenta de nuevo en unos minutos.';
    }
    return 'El modelo de IA configurado no está disponible. Revisa GEMINI_DEFAULT_MODEL en el servidor.';
  }

  if (status === 429) {
    if (lower.includes('credit') || lower.includes('billing') || lower.includes('prepayment')) {
      return 'La cuenta de Google AI se quedó sin créditos. Recarga el saldo del proyecto para volver a usar PlacePOS IA.';
    }
    return 'Se alcanzó el límite de uso de la IA por ahora. Espera un momento e intenta de nuevo.';
  }

  if (status >= 500) {
    return 'El servicio de IA de Google no está disponible en este momento. Intenta de nuevo en unos minutos.';
  }

  return 'No se pudo obtener respuesta de la IA. Intenta de nuevo.';
};

/**
 * ¿Vale la pena reintentar este fallo una vez?
 *
 * - 5xx: caída puntual del proveedor.
 * - 404 SIN cuerpo: no es "el modelo no existe" (eso viene explicado), es el
 *   404 fantasma que Google devuelve de forma intermitente; el reintento suele
 *   traer la respuesta buena o, al menos, el error de verdad (429) con su
 *   mensaje correcto.
 *
 * Nunca se reintenta un 4xx explicado (llave inválida, modelo inexistente,
 * cuota agotada): reintentar solo gasta tiempo del usuario.
 */
export const isRetriableHttpFailure = (status: number, rawBody = ''): boolean => {
  if (status >= 500) {
    return true;
  }
  return status === 404 && extractApiMessage(rawBody) === null;
};

/** Mensaje para fallos de red / timeout (no hubo respuesta HTTP). */
export const describeTransportFailure = (error: unknown): string => {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return 'La IA tardó demasiado en responder y se canceló la solicitud. Intenta con una pregunta más corta.';
  }
  return 'No se pudo conectar con el servicio de IA. Revisa la conexión del servidor e intenta de nuevo.';
};
