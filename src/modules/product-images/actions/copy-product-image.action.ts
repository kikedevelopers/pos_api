import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import { buildImageObjectName } from '../internal/image-object-name';
import { ProductImageStorageService } from '../product-image-storage.service';

/** Cuántas copias se piden a la vez en un clonado masivo a sucursal. */
const COPY_CONCURRENCY = 5;

/**
 * Copia la imagen de un producto a otro (duplicar, clonar a sucursal).
 *
 * Cada producto tiene que ser DUEÑO de su archivo. Si dos filas compartieran la
 * misma ruta, quitarle la imagen a una borraría el objeto y dejaría a la otra
 * apuntando al vacío — y peor: el usuario que la borró jamás sabría que rompió
 * otro producto. Por eso se copia el objeto (copia server-side: el binario no
 * pasa por este proceso) en lugar de copiar el string.
 *
 * NUNCA lanza. La copia ocurre DESPUÉS de que el producto ya está creado y
 * confirmado; si GCS falla, la copia nace sin foto (el usuario puede subirla) en
 * vez de perderse el duplicado entero por un problema de red.
 *
 * Ojo con COMPARTIR a sucursal: ahí no se copia nada porque no hay fila nueva —
 * la sucursal ve el producto del principal, con su misma imagen.
 */
@Injectable()
export class CopyProductImageAction {
  private readonly logger = new Logger(CopyProductImageAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: ProductImageStorageService,
  ) {}

  /** Copia la imagen de un producto a uno solo. Devuelve la ruta nueva o null. */
  async execute(params: {
    sourceImage: string | null;
    targetProductId: number;
    targetCompanyId: number;
  }): Promise<string | null> {
    const { sourceImage, targetProductId, targetCompanyId } = params;
    if (!sourceImage || !this.storage.isConfigured) {
      return null;
    }

    const extension = extensionOf(sourceImage);
    const objectName = buildImageObjectName({
      prefix: this.storage.prefix,
      companyId: targetCompanyId,
      productId: targetProductId,
      extension,
    });

    try {
      await this.storage.copy(sourceImage, objectName);
    } catch (e) {
      this.logger.warn(
        `No se pudo copiar la imagen ${sourceImage} → ${objectName}: ${(e as Error).message}. ` +
          `El producto ${targetProductId} queda sin imagen.`,
      );
      return null;
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        Product,
        { id: String(targetProductId), company_id: String(targetCompanyId) },
        { image: objectName },
      );
    });

    return objectName;
  }

  /**
   * Versión en lote para el clonado a sucursal. Concurrencia acotada: un
   * catálogo grande no debe abrir cientos de conexiones a GCS de golpe.
   */
  async executeMany(
    items: { sourceImage: string | null; targetProductId: number }[],
    targetCompanyId: number,
  ): Promise<number> {
    const pending = items.filter((item) => !!item.sourceImage);
    if (pending.length === 0 || !this.storage.isConfigured) {
      return 0;
    }

    let copied = 0;
    for (let i = 0; i < pending.length; i += COPY_CONCURRENCY) {
      const batch = pending.slice(i, i + COPY_CONCURRENCY);
      const results = await Promise.all(
        batch.map((item) =>
          this.execute({
            sourceImage: item.sourceImage,
            targetProductId: item.targetProductId,
            targetCompanyId,
          }),
        ),
      );
      copied += results.filter((r) => r !== null).length;
    }
    return copied;
  }
}

/**
 * Extensión de la ruta de origen. Se conserva la del original porque el binario
 * se copia tal cual: cambiarla dejaría un `.png` con bytes JPEG adentro.
 */
function extensionOf(objectName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(objectName);
  return match ? match[1].toLowerCase() : 'jpg';
}
