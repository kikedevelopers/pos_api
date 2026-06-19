import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PackagingsModule } from '@/modules/packagings/packagings.module';

import { BulkArchiveProductsAction } from './actions/bulk-archive-products.action';
import { BulkProcessProductsAction } from './actions/bulk-process-products.action';
import { BulkToggleShowInPosAction } from './actions/bulk-toggle-show-in-pos.action';
import { CloneProductsToBranchAction } from './actions/clone-products-to-branch.action';
import { CompareProductPricesAction } from './actions/compare-product-prices.action';
import { CreateProductAction } from './actions/create-product.action';
import { FindAllProductsAction } from './actions/find-all-products.action';
import { FindProductByIdAction } from './actions/find-product-by-id.action';
import { FindSupplierHistoryAction } from './actions/find-supplier-history.action';
import { GetProductSalesHistoryAction } from './actions/get-product-sales-history.action';
import { QuickCreateProductAction } from './actions/quick-create-product.action';
import { ShareProductsToBranchAction } from './actions/share-products-to-branch.action';
import { UpdateProductAction } from './actions/update-product.action';
import { InventoryMovement } from './entities/inventory-movement.entity';
import { InventoryShare } from './entities/inventory-share.entity';
import { Product } from './entities/product.entity';
import { ProductPrice } from './entities/product-price.entity';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

/**
 * Módulo `products` — Fase 3 + Fase 3A.
 *
 * Cablea las actions del dominio + el service facade.
 *
 * Fase 3A añadió:
 *   - `QuickCreateProductAction`
 *   - `BulkArchiveProductsAction` (reemplaza al single `ArchiveProductAction`)
 *   - `BulkToggleShowInPosAction` (reemplaza al single `ToggleShowInPosAction`)
 *   - `FindSupplierHistoryAction`
 *   - `CompareProductPricesAction`
 *
 * Importa `PackagingsModule` para validar `packaging_id` cross-tenant en
 * las actions de create/update/quick (vía SQL raw — ver `product-lookups.ts`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Product, ProductPrice, InventoryMovement, InventoryShare]),
    PackagingsModule,
  ],
  controllers: [ProductsController],
  providers: [
    ProductsService,
    FindAllProductsAction,
    FindProductByIdAction,
    CreateProductAction,
    UpdateProductAction,
    BulkArchiveProductsAction,
    BulkToggleShowInPosAction,
    BulkProcessProductsAction,
    CloneProductsToBranchAction,
    ShareProductsToBranchAction,
    GetProductSalesHistoryAction,
    QuickCreateProductAction,
    FindSupplierHistoryAction,
    CompareProductPricesAction,
  ],
  exports: [ProductsService, TypeOrmModule, CloneProductsToBranchAction, ShareProductsToBranchAction],
})
export class ProductsModule {}
