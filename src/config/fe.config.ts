import { registerAs } from '@nestjs/config';

/**
 * Configuración de la integración con el API externo de Facturación Electrónica
 * (APIDIAN, Laravel). pos_api NO reimplementa la FE: solo consume los catálogos
 * de ese API (tipos de documento, organización, régimen, responsabilidades,
 * municipios) y delega en él el armado/firma/envío a la DIAN.
 *
 * `apiBaseUrl` apunta a la raíz `/api` de APIDIAN (p.ej. `http://127.0.0.1:8081/api`
 * en desarrollo). Los catálogos cuelgan de `<apiBaseUrl>/info_initial/*`.
 */
export interface FeConfig {
  /** Raíz `/api` del API de APIDIAN. Sin barra final. */
  apiBaseUrl: string;
  /** Corte duro de cada llamada al API de FE (ms). */
  timeoutMs: number;
  /**
   * TTL del caché en memoria de los catálogos (segundos). Los catálogos de la
   * DIAN cambian rarísimo (tipos de documento, municipios); cachearlos un día
   * evita golpear APIDIAN en cada apertura del formulario de cliente.
   */
  catalogCacheTtlSeconds: number;
}

export default registerAs<FeConfig>('fe', () => ({
  apiBaseUrl: (process.env.FE_API_BASE_URL?.trim() || 'http://127.0.0.1:8081/api').replace(
    /\/+$/,
    '',
  ),
  timeoutMs: parseInt(process.env.FE_API_TIMEOUT_MS ?? '10000', 10),
  catalogCacheTtlSeconds: parseInt(process.env.FE_CATALOG_CACHE_TTL_S ?? '86400', 10),
}));
