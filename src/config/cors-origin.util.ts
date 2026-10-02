/**
 * Resolución del CORS HTTP de la API, extraída a funciones puras para poder
 * testearla sin levantar la app.
 *
 * Reglas:
 *   - Requests sin header `Origin` (curl, apps nativas, same-origin): pasan.
 *   - La whitelist explícita `CORS_ORIGINS` siempre se respeta.
 *   - El origen de la LANDING/portal (`activationBaseUrl`) se incluye SIEMPRE,
 *     aunque no esté en `CORS_ORIGINS`. La landing es, por diseño, quien sirve
 *     el portal de cuenta (`/portal/*`), la activación y la recuperación de
 *     contraseña, y por tanto un llamador cross-origin legítimo de la API. Al
 *     derivarlo de la config de la landing evitamos que un `.env` de producción
 *     desactualizado deje el portal con "Error de CORS".
 *   - En entornos NO productivos (dev) además se aceptan localhost y rangos de
 *     red privada en cualquier puerto, y si no hay whitelist configurada se
 *     refleja cualquier origen (comportamiento histórico para pruebas).
 */

// localhost / 127.0.0.1 / [::1] y rangos privados 10.x, 172.16–31.x, 192.168.x.
export const PRIVATE_LAN_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})(:\d+)?$/;

/**
 * Normaliza una base URL (p.ej. `https://placepos.kikedevs.com/activar`) a su
 * ORIGIN puro (`https://placepos.kikedevs.com`), que es la forma exacta en la
 * que el navegador envía el header `Origin`. Devuelve `null` si la entrada está
 * vacía o no es una URL absoluta válida.
 */
export function toOrigin(baseUrl: string | undefined | null): string | null {
  const trimmed = (baseUrl ?? '').trim();
  if (trimmed === '') {
    return null;
  }
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

export interface CorsResolutionInput {
  corsOrigins: string[];
  activationBaseUrl: string;
  isProdLikeEnv: boolean;
}

/**
 * Construye el conjunto de orígenes SIEMPRE permitidos: la whitelist explícita
 * más el origen derivado de la landing (`activationBaseUrl`). Sin duplicados.
 */
export function buildAllowedOrigins(input: Pick<CorsResolutionInput, 'corsOrigins' | 'activationBaseUrl'>): string[] {
  const allowed = new Set(input.corsOrigins);
  const landingOrigin = toOrigin(input.activationBaseUrl);
  if (landingOrigin !== null) {
    allowed.add(landingOrigin);
  }
  return [...allowed];
}

/**
 * Decide si un `origin` concreto debe aceptarse. Aplica las reglas descritas
 * arriba. `origin` es `undefined` cuando el request no trae header Origin.
 */
export function isOriginAllowed(
  origin: string | undefined,
  input: CorsResolutionInput,
): boolean {
  // Requests sin header Origin (curl, apps nativas, same-origin): pasan.
  if (!origin) {
    return true;
  }

  if (buildAllowedOrigins(input).includes(origin)) {
    return true;
  }

  if (!input.isProdLikeEnv && PRIVATE_LAN_ORIGIN_RE.test(origin)) {
    return true;
  }

  // Dev sin whitelist configurada: reflejar todo (comportamiento previo).
  if (!input.isProdLikeEnv && input.corsOrigins.length === 0) {
    return true;
  }

  return false;
}
