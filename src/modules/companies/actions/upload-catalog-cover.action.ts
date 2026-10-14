import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UploadedImageFile } from '@/modules/product-images/internal/image-file';
import { ProductImagesService } from '@/modules/product-images/product-images.service';

import { Company } from '../entities/company.entity';

/** Prefijo del objeto de la portada en el bucket. */
const CATALOG_COVER_KEY = 'catalog-cover';

/** Lo que se devuelve tras subir la portada. */
export interface UploadedCatalogCover {
  company: Company;
  cover_image_url: string;
}

/**
 * Sube (o reemplaza) la imagen de portada del catálogo público de la company.
 *
 * Reutiliza el almacenamiento de imágenes del inventario (misma carpeta por
 * company, validación por magic-bytes y proxy firmado). El binario se sube
 * primero y, solo entonces, se apunta la columna y se borra la portada anterior:
 * un fallo nunca deja a la company sin portada. No se exige catálogo publicado
 * para subir la portada (se puede preparar antes de publicar).
 */
@Injectable()
export class UploadCatalogCoverAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly productImages: ProductImagesService,
  ) {}

  async execute(params: {
    companyId: number;
    file: UploadedImageFile | undefined;
    actor: { id: number; fullName: string };
  }): Promise<UploadedCatalogCover> {
    const { companyId, file, actor } = params;

    const company = await this.dataSource.manager.findOne(Company, {
      where: { id: String(companyId) },
    });
    if (!company) {
      throw new NotFoundException('No se encontró información de la empresa');
    }

    const { object, url } = await this.productImages.uploadStandalone({
      companyId,
      file,
      keyHint: CATALOG_COVER_KEY,
      previousObject: company.catalog_cover_image,
      // La portada admite más peso que una foto de producto (es un banner).
      maxSizeBytes: this.productImages.coverImageMaxBytes,
      actor,
    });

    await this.dataSource.manager.update(
      Company,
      { id: String(companyId) },
      { catalog_cover_image: object },
    );

    const updated = await this.dataSource.manager.findOneOrFail(Company, {
      where: { id: String(companyId) },
    });

    return { company: updated, cover_image_url: url };
  }
}
