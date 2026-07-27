import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { BackupsConfig } from '@/config/backups.config';

import { GcsStorageService } from '../gcs-storage.service';

/**
 * Nombres de respaldo aceptados: `[entorno-]placepos-YYYYMMDD-HHMMSS.dump`.
 * El prefijo de entorno es opcional para poder seguir gestionando los respaldos
 * anteriores a esa convención.
 *
 * Es una allowlist a propósito, no un saneado: el nombre llega del cliente y se
 * usa para construir la ruta del objeto. Cualquier cosa fuera de este molde
 * (rutas con `/`, `..`, otros prefijos) se rechaza antes de tocar el bucket.
 */
const BACKUP_NAME_RE = /^(?:[a-z]{2,10}-)?placepos-\d{8}-\d{6}\.dump$/;

export interface BackupDownloadLink {
  fileName: string;
  url: string;
  /** ISO en que la URL deja de servir. */
  expiresAt: string;
}

/** Cuánto vive el enlace de descarga. Suficiente para empezar la bajada. */
const DOWNLOAD_TTL_MS = 5 * 60 * 1000;

/** Borrado y descarga de un respaldo concreto, desde el panel. */
@Injectable()
export class ManageBackupAction {
  private readonly logger = new Logger(ManageBackupAction.name);
  private readonly config: BackupsConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly storage: GcsStorageService,
  ) {
    this.config = this.configService.getOrThrow<BackupsConfig>('backups');
  }

  /** Valida el nombre y devuelve la ruta completa dentro del bucket. */
  private resolveObjectName(fileName: string): string {
    if (!BACKUP_NAME_RE.test(fileName)) {
      throw new BadRequestException('Nombre de respaldo inválido.');
    }
    return `${this.config.prefix}/${fileName}`;
  }

  private async requireFile(fileName: string) {
    const objectName = this.resolveObjectName(fileName);
    const file = this.storage.getBucket().file(objectName);
    const [exists] = await file.exists();
    if (!exists) {
      throw new NotFoundException(`El respaldo ${fileName} ya no existe.`);
    }
    return { file, objectName };
  }

  async remove(fileName: string): Promise<{ deleted: string }> {
    const { file, objectName } = await this.requireFile(fileName);
    await file.delete();
    this.logger.warn(`Respaldo borrado desde el panel: ${objectName}`);
    return { deleted: fileName };
  }

  /**
   * URL firmada (v4) para descargar el respaldo directamente de Google Storage,
   * sin que el archivo pase por la API ni por el panel. Caduca en 5 minutos.
   */
  async downloadUrl(fileName: string): Promise<BackupDownloadLink> {
    const { file } = await this.requireFile(fileName);
    const expires = Date.now() + DOWNLOAD_TTL_MS;

    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires,
      promptSaveAs: fileName,
    });

    return { fileName, url, expiresAt: new Date(expires).toISOString() };
  }
}
