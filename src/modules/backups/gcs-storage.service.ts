import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage, type Bucket } from '@google-cloud/storage';

import { resolveGcsStorageOptions } from '@/common/gcs/gcs-credentials';
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
  /** Autor del respaldo, leído de los metadatos del objeto. */
  createdBy: string | null;
  /** `manual` o `cron`; null en respaldos anteriores a esta información. */
  trigger: string | null;
  /** Entorno donde se generó (`prod`/`dev`), del metadato o del nombre. */
  environment: string | null;
  /** Versión del servidor volcado y de la herramienta que lo generó. */
  serverVersion: string | null;
  pgDumpVersion: string | null;
}

/** `prod-placepos-…` → `prod`. Respaldos antiguos (sin prefijo) → null. */
function environmentFromName(fileName: string): string | null {
  const match = /^([a-z]+)-placepos-/.exec(fileName);
  return match ? match[1] : null;
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
   * Construye el cliente. La resolución de credenciales vive en
   * `common/gcs/gcs-credentials.ts` porque es del PROYECTO, no de este módulo:
   * las imágenes del inventario se autentican exactamente igual.
   */
  private buildStorage(): Storage {
    const { options, source } = resolveGcsStorageOptions(this.config);
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
      .map((file) => {
        const fileName = file.name.split('/').pop() ?? file.name;
        const custom = file.metadata.metadata ?? {};
        return {
          name: file.name,
          fileName,
          sizeBytes: Number(file.metadata.size ?? 0),
          createdAt: String(file.metadata.timeCreated ?? ''),
          contentType: file.metadata.contentType ?? null,
          createdBy: (custom.createdBy as string | undefined) ?? null,
          trigger: (custom.trigger as string | undefined) ?? null,
          environment: (custom.environment as string | undefined) ?? environmentFromName(fileName),
          serverVersion: (custom.serverVersion as string | undefined) ?? null,
          pgDumpVersion: (custom.pgDumpVersion as string | undefined) ?? null,
        };
      })
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
