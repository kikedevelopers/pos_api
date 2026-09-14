import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import { CopyProductImageAction } from './actions/copy-product-image.action';
import { PurgeExpiredProductImagesAction } from './actions/purge-expired-product-images.action';
import { RemoveProductImageAction } from './actions/remove-product-image.action';
import { ResolveProductImageUrlsAction } from './actions/resolve-product-image-urls.action';
import { UploadProductImageAction } from './actions/upload-product-image.action';
import { ImageProxySigner } from './image-proxy-signer.service';
import { ProductImageStorageService } from './product-image-storage.service';
import { ProductImageUrlCache } from './product-image-url.cache';
import { ProductImagesController } from './product-images.controller';
import { ProductImagesScheduler } from './product-images.scheduler';
import { ProductImagesService } from './product-images.service';

/**
 * Imágenes de los items del inventario (base, presentación y combo).
 *
 * Importa SOLO la entidad `Product`, nunca `ProductsModule`: es
 * `ProductsModule` quien depende de este para subir/copiar/resolver, y una
 * dependencia en los dos sentidos sería un ciclo.
 *
 * Los endpoints de ESCRITURA (subir/quitar) viven bajo `/inventory` (en
 * `ProductsController`) porque para el cliente la imagen es un atributo del
 * producto. El único controller propio es el proxy de LECTURA
 * (`/product-images/serve`), público y firmado, que sirve los bytes.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Product])],
  controllers: [ProductImagesController],
  providers: [
    ProductImageStorageService,
    ProductImageUrlCache,
    ImageProxySigner,
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
