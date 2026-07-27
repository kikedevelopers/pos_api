import { registerAs } from '@nestjs/config';

/**
 * Respaldos de la base de datos hacia Google Cloud Storage.
 *
 * Sin `bucket` o sin credenciales el módulo queda DESHABILITADO (503), igual que
 * el módulo superadmin sin su clave pública: es preferible un error explícito a
 * un respaldo que se cree a medias.
 */
export interface BackupsConfig {
  /** Bucket destino (solo el nombre, sin `gs://`). Vacío = módulo deshabilitado. */
  bucket: string;
  /** Carpeta dentro del bucket donde viven los respaldos. */
  prefix: string;
  /**
   * Credenciales de la service account. Se admite el JSON completo pegado en la
   * variable o una ruta a un archivo. Vacío = se intentan las credenciales por
   * defecto del entorno (ADC).
   */
  credentialsJson: string;
  credentialsFile: string;
  /** Proyecto de GCP; normalmente ya viene dentro del JSON de la service account. */
  projectId: string;
  /**
   * De dónde salen las credenciales de GCS. `auto` = ADC en producción (la
   * identidad de la VM) y archivo/JSON local fuera de producción. Ver
   * `GcsStorageService.resolveCredentials`.
   */
  credentialsMode: 'auto' | 'adc' | 'file' | 'json';
  /** Entorno de ejecución; decide el comportamiento de `credentialsMode: auto`. */
  nodeEnv: string;
  /**
   * Ruta del binario `pg_dump`. Vacío = se busca en el PATH.
   *
   * Hace falta cuando el cliente no está en el PATH del proceso: en macOS,
   * Homebrew instala `libpq` como keg-only y su `pg_dump` NO queda enlazado.
   */
  pgDumpBin: string;
  /** Interruptor del respaldo automático diario (cron de medianoche). */
  cronEnabled: boolean;
  /** Corta un `pg_dump` que se quede colgado (ms). */
  timeoutMs: number;
  /**
   * Cuántos respaldos se conservan en el bucket. Al crear uno nuevo se borran
   * los más antiguos para no superarlo NUNCA (ver `create-backup.action`).
   */
  maxBackups: number;
}

export default registerAs<BackupsConfig>('backups', () => ({
  bucket: process.env.GCS_BACKUP_BUCKET ?? '',
  prefix: (process.env.GCS_BACKUP_PREFIX ?? 'backups').replace(/^\/+|\/+$/g, ''),
  credentialsJson: process.env.GCS_CREDENTIALS_JSON ?? '',
  credentialsFile: process.env.GCS_CREDENTIALS_FILE ?? '',
  projectId: process.env.GCS_PROJECT_ID ?? '',
  credentialsMode: (process.env.GCS_CREDENTIALS_MODE ?? 'auto') as BackupsConfig['credentialsMode'],
  nodeEnv: process.env.NODE_ENV ?? 'development',
  cronEnabled: process.env.BACKUP_CRON_ENABLED !== 'false',
  pgDumpBin: process.env.PG_DUMP_BIN ?? '',
  timeoutMs: parseInt(process.env.BACKUP_TIMEOUT_MS ?? '600000', 10),
  maxBackups: Math.max(1, parseInt(process.env.BACKUP_MAX_FILES ?? '7', 10) || 7),
}));
