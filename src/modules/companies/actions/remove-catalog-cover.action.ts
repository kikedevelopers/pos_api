import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ProductImagesService } from '@/modules/product-images/product-images.service';

import { Company } from '../entities/company.entity';

/**
 * Quita la imagen de portada del catálogo: pone la columna en `null` y borra el
 * objeto del bucket. Idempotente: si no había portada, no hace nada y devuelve
 * la company igual. El catálogo vuelve al hero por defecto.
 */
@Injectable()
export class RemoveCatalogCoverAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly productImages: ProductImagesService,
  ) {}

  async execute(companyId: number): Promise<Company> {
    const company = await this.dataSource.manager.findOne(Company, {
      where: { id: String(companyId) },
    });
    if (!company) {
      throw new NotFoundException('No se encontró información de la empresa');
    }

    const previous = company.catalog_cover_image;
    if (!previous) {
      return company;
    }

    await this.dataSource.manager.update(
      Company,
      { id: String(companyId) },
      { catalog_cover_image: null },
    );

    // Borrado best-effort del bucket (nunca lanza). Solo toca objetos de la
    // propia company.
    await this.productImages.removeImages([previous], companyId);

    return this.dataSource.manager.findOneOrFail(Company, {
      where: { id: String(companyId) },
    });
  }
}
