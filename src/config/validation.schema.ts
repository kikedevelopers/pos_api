import * as Joi from 'joi';

/**
 * Placeholder del `.env.example`. Joi lo rechaza explícitamente en
 * `NODE_ENV=production` para que un deploy con el valor por defecto del
 * archivo de ejemplo falle al arrancar en vez de quedarse silenciosamente
 * con un secret conocido.
 */
const JWT_SECRET_PLACEHOLDER = 'REPLACE_ME_WITH_OPENSSL_RAND_BASE64_48';

/**
 * Esquema de validación de variables de entorno.
 * Si alguna variable falta o es inválida, la aplicación falla al arrancar.
 */
export const validationSchema = Joi.object({
  // Aplicación
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),

  // Base de datos
  DB_HOST: Joi.string().hostname().required(),
  DB_PORT: Joi.number().integer().min(1).max(65535).default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').required(),
  DB_NAME: Joi.string().required(),
  DB_SYNCHRONIZE: Joi.boolean().default(false),
  DB_LOGGING: Joi.boolean().default(false),
  DB_SSL: Joi.boolean().default(false),

  // Throttling
  THROTTLE_TTL: Joi.number().integer().min(1).default(60000),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),

  // Trust proxy — # de hops a confiar tras un LB/reverse proxy. 0 = sin proxy.
  // También se aceptan booleanos y los keywords de Express
  // ('loopback' | 'linklocal' | 'uniquelocal').
  TRUST_PROXY: Joi.alternatives()
    .try(
      Joi.number().integer().min(0).max(10),
      Joi.boolean(),
      Joi.string().valid('loopback', 'linklocal', 'uniquelocal'),
    )
    .default(0),

  // Swagger
  SWAGGER_ENABLED: Joi.boolean().default(true),

  // CORS
  CORS_ORIGINS: Joi.string().default(''),

  // JWT / Auth
  // - `min(64)`: 64 chars resisten brute force razonablemente (mínimo
  //    recomendado: 256 bits ~ 43 base64url chars; subimos a 64 por margen).
  // - en `NODE_ENV=production` rechazamos el placeholder del `.env.example`
  //    para que un deploy descuidado falle al arrancar en vez de aceptar un
  //    secret de dominio público.
  JWT_SECRET: Joi.string()
    .min(64)
    .required()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().disallow(JWT_SECRET_PLACEHOLDER),
    }),
  JWT_EXPIRES_OWNER: Joi.string().default('7d'),
  JWT_EXPIRES_EMPLOYEE: Joi.string().default('1d'),
});
