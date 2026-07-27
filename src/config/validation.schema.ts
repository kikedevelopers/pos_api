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
  // Por defecto string vacío: el cliente PlacePos consume el API en raíz.
  // `allow('')` es necesario porque Joi por defecto rechaza strings vacíos.
  API_PREFIX: Joi.string().allow('').default(''),
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

  // Firma asimétrica para endpoints /admin/* (paneles externos, p.ej.
  // kdevs-admin). Clave pública Ed25519 en base64 (SPKI). Vacío = deshabilita
  // esos endpoints firmados. `ADMIN_SIGNATURE_MAX_SKEW_MS` = ventana anti-replay.
  ADMIN_SIGNING_PUBLIC_KEY: Joi.string().allow('').default(''),
  ADMIN_SIGNATURE_MAX_SKEW_MS: Joi.number().integer().min(1000).default(300000),

  // Firma asimétrica para endpoints /superadmin/* (panel kdevs-admin). PAR
  // DEDICADO, distinto del de /admin/*. Clave pública Ed25519 en base64 (SPKI);
  // la privada vive SOLO en el navegador del superadmin. Vacío = deshabilita
  // los endpoints /superadmin/*. `SUPERADMIN_SIGNATURE_MAX_SKEW_MS` = ventana
  // anti-replay dedicada (más corta: cubre el borrado total de tenant).
  SUPERADMIN_SIGNING_PUBLIC_KEY: Joi.string().allow('').default(''),
  SUPERADMIN_SIGNATURE_MAX_SKEW_MS: Joi.number().integer().min(1000).default(120000),

  // Respaldos de la BD hacia Google Cloud Storage (módulo /backups/*). Sin
  // bucket el módulo queda deshabilitado (503). Las credenciales admiten JSON
  // en línea o ruta a archivo; vacías = credenciales por defecto del entorno.
  GCS_BACKUP_BUCKET: Joi.string().allow('').default(''),
  GCS_BACKUP_PREFIX: Joi.string().allow('').default('backups'),
  GCS_CREDENTIALS_JSON: Joi.string().allow('').default(''),
  GCS_CREDENTIALS_FILE: Joi.string().allow('').default(''),
  GCS_PROJECT_ID: Joi.string().allow('').default(''),
  // auto = ADC en producción (identidad de la VM), archivo/JSON en local.
  GCS_CREDENTIALS_MODE: Joi.string().valid('auto', 'adc', 'file', 'json').default('auto'),
  // Respaldo automático diario (medianoche, hora Colombia). 'false' lo apaga.
  BACKUP_CRON_ENABLED: Joi.boolean().default(true),
  // Ruta del binario pg_dump; vacío = se busca en el PATH del proceso.
  PG_DUMP_BIN: Joi.string().allow('').default(''),
  BACKUP_TIMEOUT_MS: Joi.number().integer().min(10000).default(600000),
  // Retención: nunca puede haber más de este número de respaldos en el bucket.
  BACKUP_MAX_FILES: Joi.number().integer().min(1).max(365).default(7),
});
