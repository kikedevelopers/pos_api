/**
 * Traducción de fallos de los proveedores de correo a mensajes que un humano
 * entiende sin abrir el log. Puro y testeado: es lo que ve el operador en el
 * panel cuando los correos dejan de salir.
 */

/** Saca el mensaje que el proveedor puso en el cuerpo JSON, si lo hay. */
const extractApiMessage = (rawBody: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    // Resend usa `message`; otros proveedores anidan en `error.message` o
    // devuelven una lista en `errors[].message`.
    const direct = record.message ?? record.error;
    if (typeof direct === 'string' && direct.trim().length > 0) {
      return direct.trim();
    }
    if (direct && typeof direct === 'object') {
      const nested = (direct as { message?: unknown }).message;
      if (typeof nested === 'string' && nested.trim().length > 0) {
        return nested.trim();
      }
    }
    const list = record.errors;
    if (Array.isArray(list) && list.length > 0) {
      const first = (list[0] as { message?: unknown }).message;
      if (typeof first === 'string' && first.trim().length > 0) {
        return first.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
};

/** Detalle técnico para el log, nunca para el usuario. */
export const extractMailErrorDetail = (rawBody: string): string =>
  extractApiMessage(rawBody) ?? rawBody.slice(0, 500);

/**
 * Mensaje de cara al operador para un status HTTP del proveedor.
 * `rawBody` es el cuerpo crudo de la respuesta (puede venir vacío).
 */
export const describeMailHttpFailure = (status: number, rawBody = ''): string => {
  const apiMessage = extractApiMessage(rawBody) ?? '';
  const lower = apiMessage.toLowerCase();

  if (status === 401 || status === 403) {
    return 'El proveedor rechazó la llave de envío. Revisa RESEND_API_KEY en el servidor.';
  }

  if (status === 422 || status === 400) {
    // El error más común al arrancar: el dominio del remitente no está
    // verificado en el proveedor, así que ningún correo va a salir hasta
    // arreglar el DNS. Merece su propio mensaje.
    if (lower.includes('domain') || lower.includes('verify') || lower.includes('not verified')) {
      return 'El dominio del remitente no está verificado en el proveedor. Verifícalo o cambia MAIL_FROM.';
    }
    if (lower.includes('from')) {
      return 'El remitente (MAIL_FROM) no es válido para el proveedor.';
    }
    if (lower.includes('to') || lower.includes('recipient')) {
      return 'La dirección de destino no es válida.';
    }
    return 'El proveedor rechazó el correo por datos inválidos.';
  }

  if (status === 429) {
    return 'Se alcanzó el límite de envíos del proveedor. Espera un momento e intenta de nuevo.';
  }

  if (status >= 500) {
    return 'El proveedor de correo no está disponible en este momento. Intenta de nuevo en unos minutos.';
  }

  return 'No se pudo enviar el correo. Revisa la configuración del proveedor.';
};

/** ¿Vale la pena reintentar? Solo caídas del proveedor y límites de tasa. */
export const isRetriableMailFailure = (status: number): boolean => status >= 500 || status === 429;

/** Mensaje para fallos de red / timeout (no hubo respuesta HTTP). */
export const describeMailTransportFailure = (error: unknown): string => {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return 'El proveedor de correo tardó demasiado en responder y se canceló el envío.';
  }
  return 'No se pudo conectar con el proveedor de correo. Revisa la conexión del servidor.';
};

/**
 * Señales de límite de tasa dentro del texto de la respuesta SMTP.
 *
 * Hacen falta porque varios servidores devuelven el rate limit como 5xx, que
 * por código sería definitivo. Mailtrap, por ejemplo, responde
 * `550 5.7.0 Too many emails per second`: tratarlo como definitivo hace perder
 * un correo que un reintento a segundos vista habría entregado.
 */
const SMTP_RATE_LIMIT_HINTS = ['too many', 'rate limit', 'try again later', 'throttl', 'quota'];

/**
 * Traducción de los fallos de SMTP, que no vienen por HTTP sino con códigos
 * propios (`EAUTH`, `ECONNECTION`…) o el código de respuesta del servidor.
 */
export const describeSmtpFailure = (error: unknown): string => {
  const err = (error ?? {}) as { code?: string; responseCode?: number; message?: string };
  const code = err.code ?? '';
  const responseCode = err.responseCode ?? 0;

  if (code === 'EAUTH' || responseCode === 535 || responseCode === 534) {
    return 'El servidor SMTP rechazó el usuario o la contraseña. Revisa SMTP_USERNAME y SMTP_PASSWORD.';
  }
  if (code === 'ECONNECTION' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
    return 'No se pudo conectar con el servidor SMTP. Revisa SMTP_HOST y SMTP_PORT.';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET') {
    return 'El servidor SMTP no respondió a tiempo. Revisa el host, el puerto y el firewall.';
  }
  const lower = (err.message ?? '').toLowerCase();
  if (SMTP_RATE_LIMIT_HINTS.some((hint) => lower.includes(hint))) {
    return 'El servidor de correo está limitando los envíos. Espera un momento e intenta de nuevo.';
  }
  if (responseCode >= 500) {
    return 'El servidor SMTP rechazó el correo de forma definitiva.';
  }
  if (responseCode >= 400) {
    return 'El servidor SMTP rechazó el correo temporalmente. Intenta de nuevo.';
  }
  return 'No se pudo enviar el correo por SMTP.';
};

/** ¿El fallo SMTP es transitorio? Los 4xx lo son, y los límites de tasa también. */
export const isRetriableSmtpFailure = (error: unknown): boolean => {
  const err = (error ?? {}) as { code?: string; responseCode?: number; message?: string };
  if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || err.code === 'ECONNECTION') {
    return true;
  }
  const lower = (err.message ?? '').toLowerCase();
  if (SMTP_RATE_LIMIT_HINTS.some((hint) => lower.includes(hint))) {
    return true;
  }
  const responseCode = err.responseCode ?? 0;
  return responseCode >= 400 && responseCode < 500;
};
