import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PackagingsModule } from '@/modules/packagings/packagings.module';

import { ArchiveProductAction } from './actions/archive-product.action';
import { BulkProcessProductsAction } from './actions/bulk-process-products.action';
import { CreateProductAction } from './actions/create-product.action';
import { FindAllProductsAction } from './actions/find-all-products.action';
import { FindProductByIdAction } from './actions/find-product-by-id.action';
import { GetProductSalesHistoryAction } from './actions/get-product-sales-history.action';
import { ToggleShowInPosAction } from './actions/toggle-show-in-pos.action';
import { UpdateProductAction } from './actions/update-product.action';
import { Product } from './entities/product.entity';
import { ProductPrice } from './entities/product-price.entity';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

/**
 * Módulo `products` — Fase 3.
 *
 * Cablea las 8 actions del dominio (find-all, find-by-id, create, update,
 * archive, toggle-show-in-pos, bulk-process, get-sales-history) + el
 * service facade.
 *
 * Importa `PackagingsModule` para validar `packaging_id` cross-tenant en
 * las actions de create/update (vía SQL raw — ver `product-lookups.ts`).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Product, ProductPrice]), PackagingsModule],
  controllers: [ProductsController],
  providers: [
    ProductsService,
    FindAllProductsAction,
    FindProductByIdAction,
    CreateProductAction,
    UpdateProductAction,
    ArchiveProductAction,
    ToggleShowInPosAction,
    BulkProcessProductsAction,
    GetProductSalesHistoryAction,
  ],
  exports: [ProductsService, TypeOrmModule],
})
export class ProductsModule {}
