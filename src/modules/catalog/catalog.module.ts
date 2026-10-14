import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import { ProductImagesModule } from '@/modules/product-images/product-images.module';

import { GetPublicCatalogAction } from './actions/get-public-catalog.action';
import { CatalogController } from './catalog.controller';

/**
 * Módulo `catalog` — catálogo PÚBLICO por tenant (lo consume la landing en
 * `/catalog/<slug>`). Solo lectura y anónimo.
 *
 * Reutiliza `ProductImagesModule` (`ProductImagesService.resolveUrls`) para
 * firmar las URLs del proxy de imágenes; el endpoint `GET /product-images/serve`
 * ya es `@Public()`, así que las imágenes cargan para clientes anónimos.
 *
 * La configuración (habilitar + slug) vive en el módulo `companies`; aquí solo
 * se LEE el catálogo.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Company]), ProductImagesModule],
  controllers: [CatalogController],
  providers: [GetPublicCatalogAction],
})
export class CatalogModule {}
