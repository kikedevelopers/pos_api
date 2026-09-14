import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage, type Bucket } from '@google-cloud/storage';

import { resolveGcsStorageOptions } from '@/common/gcs/gcs-credentials';
import type { BackupsConfig } from '@/config/backups.config';
import type { ProductImagesConfig } from '@/config/product-images.config';

/**
 * Acceso a Google Cloud Storage para las imágenes del inventario.
 *
 * Vive en el mismo bucket que los respaldos, en la carpeta `inventory_items/`.
 * Las credenciales se resuelven con el helper compartido
 * (`common/gcs/gcs-credentials.ts`): son las del proyecto, las mismas que usan
 * los respaldos, y duplicar esa lógica sería la forma de que un día divergieran.
 *
 * El cliente se construye PEREZOSAMENTE: la app arranca igual sin bucket ni
 * credenciales, y solo falla (503) quien intente subir una imagen.
 */
@Injectable()
export class ProductImageStorageService {
  private readonly logger = new Logger(ProductImageStorageService.name);
  private readonly config: ProductImagesConfig;
  /** Namespace de credenciales; ver comentario del constructor. */
  private readonly credentials: BackupsConfig;
  private storage: Storage | null = null;

  constructor(private readonly configService: ConfigService) {
    this.config = this.configService.getOrThrow<ProductImagesConfig>('productImages');
    // Las credenciales de GCS viven en el namespace `backups` por historia (las
    // variables se llaman `GCS_CREDENTIALS_*`, no `BACKUP_*`): son del proyecto
    // entero. Leerlas de ahí evita pedirle al operador que configure dos veces
    // la misma service account.
    this.credentials = this.configService.getOrThrow<BackupsConfig>('backups');
  }

  /** ¿Hay bucket configurado? Sin él no se pueden subir imágenes. */
  get isConfigured(): boolean {
    return this.config.bucket.length > 0;
  }

  get bucketName(): string {
    return this.config.bucket;
  }

  get prefix(): string {
    return this.config.prefix;
  }

  get maxSizeBytes(): number {
    return this.config.maxSizeBytes;
  }

  get signedUrlTtlSeconds(): number {
    return this.config.signedUrlTtlSeconds;
  }

  get retentionDaysAfterArchive(): number {
    return this.config.retentionDaysAfterArchive;
  }

  private getBucket(): Bucket {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException({
        message: 'Las imágenes de productos no están configuradas en este servidor.',
        payload: { code: 'IMAGE_STORAGE_UNAVAILABLE' },
      });
    }
    if (!this.storage) {
      const { options, source } = resolveGcsStorageOptions(this.credentials);
      this.logger.log(
        `Imágenes de inventario: autenticando con ${source} (bucket ${this.config.bucket}).`,
      );
      this.storage = new Storage(options);
    }
    return this.storage.bucket(this.config.bucket);
  }

  /** Sube el binario y deja el objeto listo. Sobrescribe si la ruta existiera. */
  async upload(params: {
    objectName: string;
    buffer: Buffer;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<void> {
    const file = this.getBucket().file(params.objectName);
    await file.save(params.buffer, {
      contentType: params.contentType,
      resumable: false,
      metadata: {
        contentType: params.contentType,
        // Un año de caché en el navegador es seguro porque la ruta cambia con
        // cada imagen nueva: un reemplazo NUNCA reutiliza la URL anterior.
        cacheControl: 'private, max-age=31536000',
        metadata: params.metadata ?? {},
      },
    });
  }

  /**
   * URL firmada de lectura. Es la única forma de que el navegador vea la imagen
   * sin abrir el bucket al público.
   */
  async getSignedUrl(objectName: string): Promise<string> {
    const [url] = await this.getBucket()
      .file(objectName)
      .getSignedUrl({
        action: 'read',
        version: 'v4',
        expires: Date.now() + this.config.signedUrlTtlSeconds * 1000,
      });
    return url;
  }

  /**
   * Copia server-side (el binario nunca pasa por este proceso). La usan
   * duplicar y clonar a sucursal para que cada producto sea DUEÑO de su
   * archivo: si dos filas compartieran ruta, borrar la imagen de una dejaría a
   * la otra apuntando al vacío.
   */
  async copy(sourceObject: string, destinationObject: string): Promise<void> {
    const bucket = this.getBucket();
    await bucket.file(sourceObject).copy(bucket.file(destinationObject));
  }

  /**
   * Borra un objeto. Nunca lanza: un archivo que ya no está (o un bucket
   * temporalmente caído) no debe tumbar la operación de negocio que lo
   * disparó — el producto ya se guardó. Devuelve si el borrado ocurrió.
   */
  async remove(objectName: string): Promise<boolean> {
    try {
      await this.getBucket().file(objectName).delete({ ignoreNotFound: true });
      return true;
    } catch (e) {
      this.logger.warn(`No se pudo borrar la imagen ${objectName}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Prefijo de la carpeta de una company, con la barra final. */
  companyPrefix(companyId: number): string {
    return `${this.prefix}/${companyId}/`;
  }

  /**
   * Borra TODAS las imágenes de una company de una vez.
   *
   * La usan los borrados DUROS (eliminar un tenant, vaciar su inventario), donde
   * las filas desaparecen de la BD y con ellas la única referencia a sus
   * archivos: sin esto, esas imágenes se quedarían en el bucket para siempre y
   * nadie sabría ya a qué producto pertenecían. Se borra por prefijo, así que no
   * hace falta enumerar rutas.
   *
   * Nunca lanza: el tenant ya se eliminó y un fallo aquí no puede revertirlo.
   */
  async removeCompanyFolder(companyId: number): Promise<void> {
    if (!this.isConfigured) {
      return;
    }
    const prefix = this.companyPrefix(companyId);
    try {
      await this.getBucket().deleteFiles({ prefix, force: true });
      this.logger.log(`Imágenes borradas del bucket: ${prefix}`);
    } catch (e) {
      this.logger.warn(`No se pudieron borrar las imágenes de ${prefix}: ${(e as Error).message}`);
    }
  }
}
