import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import { CopyProductImageAction } from './actions/copy-product-image.action';
import { PurgeExpiredProductImagesAction } from './actions/purge-expired-product-images.action';
import { RemoveProductImageAction } from './actions/remove-product-image.action';
import { ResolveProductImageUrlsAction } from './actions/resolve-product-image-urls.action';
import { UploadProductImageAction } from './actions/upload-product-image.action';
import { ProductImageStorageService } from './product-image-storage.service';
import { ProductImageUrlCache } from './product-image-url.cache';
import { ProductImagesScheduler } from './product-images.scheduler';
import { ProductImagesService } from './product-images.service';

/**
 * Imágenes de los items del inventario (base, presentación y combo).
 *
 * Importa SOLO la entidad `Product`, nunca `ProductsModule`: es
 * `ProductsModule` quien depende de este para subir/copiar/resolver, y una
 * dependencia en los dos sentidos sería un ciclo.
 *
 * El módulo no expone controller propio — los endpoints viven bajo `/inventory`
 * (en `ProductsController`) porque para el cliente la imagen es un atributo del
 * producto, no un recurso aparte.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Product])],
  providers: [
    ProductImageStorageService,
    ProductImageUrlCache,
    ProductImagesService,
    ProductImagesScheduler,
    UploadProductImageAction,
    RemoveProductImageAction,
    ResolveProductImageUrlsAction,
    CopyProductImageAction,
    PurgeExpiredProductImagesAction,
  ],
  exports: [ProductImagesService, ProductImageUrlCache],
})
export class ProductImagesModule {}
