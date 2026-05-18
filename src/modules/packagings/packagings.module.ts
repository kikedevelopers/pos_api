import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import { ArchivePackagingAction } from './actions/archive-packaging.action';
import { CreatePackagingAction } from './actions/create-packaging.action';
import { FindAllPackagingsAction } from './actions/find-all-packagings.action';
import { ListProductsByPackagingAction } from './actions/list-products-by-packaging.action';
import { UpdatePackagingAction } from './actions/update-packaging.action';
import { Packaging } from './entities/packaging.entity';
import { PackagingsController } from './packagings.controller';
import { PackagingsService } from './packagings.service';

/**
 * Módulo `packagings` — Fase 3 + Fase 3A.
 *
 * Cablea las actions del dominio + el service facade.
 *
 * Fase 3A añadió:
 *   - `ListProductsByPackagingAction` (endpoint `GET /:id/products`).
 *     Necesita el repositorio de `Product`; lo incluimos en `forFeature`
 *     SIN importar `ProductsModule` (eso crearía un ciclo entre los dos
 *     módulos). El repositorio se exporta a través de TypeOrmModule.
 *
 * `TypeOrmModule` se exporta para que `ProductsModule` (también Fase 3)
 * pueda inyectar el repositorio de `Packaging` sin reabrir `forFeature`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Packaging, Product])],
  controllers: [PackagingsController],
  providers: [
    PackagingsService,
    FindAllPackagingsAction,
    CreatePackagingAction,
    UpdatePackagingAction,
    ArchivePackagingAction,
    ListProductsByPackagingAction,
  ],
  exports: [PackagingsService, TypeOrmModule],
})
export class PackagingsModule {}
