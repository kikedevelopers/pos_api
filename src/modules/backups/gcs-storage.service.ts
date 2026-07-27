import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage, type Bucket, type StorageOptions } from '@google-cloud/storage';

import type { BackupsConfig } from '@/config/backups.config';

/** Un objeto de respaldo tal como vive en el bucket. */
export interface StoredBackup {
  /** Ruta completa dentro del bucket (`backups/pos_db-2026-07-27T12-00-00Z.dump`). */
  name: string;
  /** Nombre del archivo, sin la carpeta. */
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  contentType: string | null;
}

/**
 * Acceso a Google Cloud Storage para los respaldos de la BD.
 *
 * El cliente se construye PEREZOSAMENTE: así la app arranca igual aunque el
 * bucket o las credenciales no estén configurados, y solo falla (503) quien
 * intente usar el módulo.
 */
@Injectable()
export class GcsStorageService {
  private readonly logger = new Logger(GcsStorageService.name);
  private readonly config: BackupsConfig;
  private storage: Storage | null = null;

  constructor(private readonly configService: ConfigService) {
    this.config = this.configService.getOrThrow<BackupsConfig>('backups');
  }

  /** ¿Hay bucket configurado? Sin él, el módulo no opera. */
  get isConfigured(): boolean {
    return this.config.bucket.length > 0;
  }

  get bucketName(): string {
    return this.config.bucket;
  }

  get prefix(): string {
    return this.config.prefix;
  }

  /**
   * Cómo se autentica contra GCS, según `GCS_CREDENTIALS_MODE`:
   *
   *   - `auto` (por defecto): en PRODUCCIÓN usa las credenciales propias de la
   *     máquina (ADC: la service account que Google adjunta a la VM), sin
   *     secretos en el `.env`. Fuera de producción usa el JSON/archivo local si
   *     está configurado, que es como se trabaja en el Mac.
   *   - `adc`: fuerza credenciales del entorno en cualquier NODE_ENV.
   *   - `file` / `json`: fuerza el archivo o el JSON en línea (útil si la VM de
   *     producción NO tiene identidad adjunta).
   *
   * El modo elegido se registra al construir el cliente: si un día falla la
   * autenticación en la VM, el log dice de dónde se intentaron sacar las claves.
   */
  private resolveCredentials(options: StorageOptions): string {
    const explicitJson = this.config.credentialsJson.trim();
    const explicitFile = this.config.credentialsFile.trim();
    const isProduction = this.config.nodeEnv === 'production';
    const mode = this.config.credentialsMode;

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
      return 'JSON en variable de entorno';
    }

    if (useFile) {
      if (!explicitFile) {
        throw new ServiceUnavailableException(
          'GCS_CREDENTIALS_MODE=file pero GCS_CREDENTIALS_FILE está vacío.',
        );
      }
      options.keyFilename = explicitFile;
      return `archivo ${explicitFile}`;
    }

    return isProduction
      ? 'credenciales de la máquina (ADC)'
      : 'credenciales por defecto del entorno (ADC)';
  }

  private buildStorage(): Storage {
    const options: StorageOptions = {};
    if (this.config.projectId) {
      options.projectId = this.config.projectId;
    }

    const source = this.resolveCredentials(options);
    this.logger.log(`Google Storage: autenticando con ${source} (bucket ${this.config.bucket}).`);

    return new Storage(options);
  }

  /** Bucket listo para usar. Lanza 503 si el módulo no está configurado. */
  getBucket(): Bucket {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException('Respaldos no configurados: falta GCS_BACKUP_BUCKET.');
    }
    if (!this.storage) {
      this.storage = this.buildStorage();
    }
    return this.storage.bucket(this.config.bucket);
  }

  /** Respaldos existentes, del más reciente al más antiguo. */
  async list(): Promise<StoredBackup[]> {
    const bucket = this.getBucket();
    const [files] = await bucket.getFiles({ prefix: `${this.config.prefix}/` });

    return files
      .filter((file) => !file.name.endsWith('/'))
      .map((file) => ({
        name: file.name,
        fileName: file.name.split('/').pop() ?? file.name,
        sizeBytes: Number(file.metadata.size ?? 0),
        createdAt: String(file.metadata.timeCreated ?? ''),
        contentType: file.metadata.contentType ?? null,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Borra un objeto del bucket (usado para limpiar un respaldo fallido). */
  async remove(objectName: string): Promise<void> {
    try {
      await this.getBucket().file(objectName).delete({ ignoreNotFound: true });
    } catch (e) {
      this.logger.warn(`No se pudo borrar ${objectName}: ${(e as Error).message}`);
    }
  }
}
