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
}));
