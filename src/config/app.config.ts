import { registerAs } from '@nestjs/config';

/**
 * Configuración general de la aplicación (puerto, prefijo, CORS, logging, swagger, throttling).
 */
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'staging' | 'production';
  port: number;
  apiPrefix: string;
  logLevel: string;
  corsOrigins: string[];
  swaggerEnabled: boolean;
  throttle: {
    ttl: number;
    limit: number;
  };
  /**
   * Autenticación por firma asimétrica para endpoints `/admin/*` consumidos
   * por paneles externos (p.ej. kdevs-admin). El panel firma cada request con
   * su clave privada Ed25519; aquí guardamos la clave pública (SPKI en base64)
   * para verificar. `publicKey` vacío = endpoints firmados deshabilitados.
   */
  adminSigning: {
    publicKey: string;
    /**
     * Clave pública Ed25519 (SPKI en base64) del PAR DEDICADO del superadmin
     * (kdevs-admin). Es DISTINTA de `publicKey` (par de migration-import): la
     * privada vive SOLO en el navegador del panel superadmin. Verifica las
     * rutas `/superadmin/*` vía `SuperadminSignatureGuard`. Vacío = esos
     * endpoints quedan deshabilitados (503).
     */
    superadminPublicKey: string;
    maxSkewMs: number;
    /**
     * Ventana anti-replay DEDICADA del superadmin. Más corta que la de admin
     * porque cubre operaciones destructivas (borrado total de tenant).
     */
    superadminMaxSkewMs: number;
  };
}

export default registerAs<AppConfig>('app', () => ({
  nodeEnv: (process.env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'],
  port: parseInt(process.env.PORT ?? '3000', 10),
  // Por defecto SIN prefix global. El cliente PlacePos llama a `/sales`,
  // `/auth/user`, etc. en raíz. Mantenemos `API_PREFIX` env por compatibilidad
  // operativa: si alguien necesita servir el API en un sub-path lo activa.
  apiPrefix: process.env.API_PREFIX ?? '',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  swaggerEnabled: process.env.SWAGGER_ENABLED === 'true',
  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },
  adminSigning: {
    publicKey: process.env.ADMIN_SIGNING_PUBLIC_KEY ?? '',
    superadminPublicKey: process.env.SUPERADMIN_SIGNING_PUBLIC_KEY ?? '',
    maxSkewMs: parseInt(process.env.ADMIN_SIGNATURE_MAX_SKEW_MS ?? '300000', 10),
    superadminMaxSkewMs: parseInt(process.env.SUPERADMIN_SIGNATURE_MAX_SKEW_MS ?? '120000', 10),
  },
}));
