import { ServiceUnavailableException } from '@nestjs/common';
import type { StorageOptions } from '@google-cloud/storage';

/**
 * Credenciales de Google Cloud Storage. Son del PROYECTO, no de un módulo: las
 * usan tanto los respaldos de la BD como las imágenes del inventario, y por eso
 * las variables se llaman `GCS_CREDENTIALS_*` y no `BACKUP_*`.
 */
export interface GcsCredentialsInput {
  /** JSON completo de la service account pegado en la variable de entorno. */
  credentialsJson: string;
  /** Ruta a un archivo JSON de service account. */
  credentialsFile: string;
  /** Proyecto de GCP; normalmente ya viene dentro del JSON. */
  projectId: string;
  /** Ver {@link resolveGcsStorageOptions}. */
  credentialsMode: 'auto' | 'adc' | 'file' | 'json';
  /** Entorno de ejecución; decide el comportamiento del modo `auto`. */
  nodeEnv: string;
}

/** Opciones listas para `new Storage(...)` + de dónde salieron las claves. */
export interface ResolvedGcsOptions {
  options: StorageOptions;
  /** Descripción legible del origen, para el log de arranque. */
  source: string;
}

/**
 * Traduce la configuración a las opciones del cliente de Storage, según
 * `GCS_CREDENTIALS_MODE`:
 *
 *   - `auto` (por defecto): en PRODUCCIÓN usa las credenciales propias de la
 *     máquina (ADC: la service account que Google adjunta a la VM), sin
 *     secretos en el `.env`. Fuera de producción usa el JSON/archivo local si
 *     está configurado, que es como se trabaja en el Mac.
 *   - `adc`: fuerza credenciales del entorno en cualquier NODE_ENV.
 *   - `file` / `json`: fuerza el archivo o el JSON en línea (útil si la VM de
 *     producción NO tiene identidad adjunta).
 *
 * El `source` que devuelve se registra al construir el cliente: si un día falla
 * la autenticación en la VM, el log dice de dónde se intentaron sacar las claves.
 */
export function resolveGcsStorageOptions(input: GcsCredentialsInput): ResolvedGcsOptions {
  const options: StorageOptions = {};
  if (input.projectId) {
    options.projectId = input.projectId;
  }

  const explicitJson = input.credentialsJson.trim();
  const explicitFile = input.credentialsFile.trim();
  const isProduction = input.nodeEnv === 'production';
  const mode = input.credentialsMode;

  const useJson = mode === 'json' || (mode === 'auto' && !isProduction && !!explicitJson);
  const useFile =
    mode === 'file' || (mode === 'auto' && !isProduction && !explicitJson && !!explicitFile);

  if (useJson) {
    if (!explicitJson) {
      throw new ServiceUnavailableException(
        'GCS_CREDENTIALS_MODE=json pero GCS_CREDENTIALS_JSON está vacío.',
      );
    }
    try {
      options.credentials = JSON.parse(explicitJson) as StorageOptions['credentials'];
    } catch {
      throw new ServiceUnavailableException(
        'GCS_CREDENTIALS_JSON no es un JSON válido de service account.',
      );
    }
    return { options, source: 'JSON en variable de entorno' };
  }

  if (useFile) {
    if (!explicitFile) {
      throw new ServiceUnavailableException(
        'GCS_CREDENTIALS_MODE=file pero GCS_CREDENTIALS_FILE está vacío.',
      );
    }
    options.keyFilename = explicitFile;
    return { options, source: `archivo ${explicitFile}` };
  }

  return {
    options,
    source: isProduction
      ? 'credenciales de la máquina (ADC)'
      : 'credenciales por defecto del entorno (ADC)',
  };
}
