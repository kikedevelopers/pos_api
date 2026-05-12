import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ArchivePackagingAction } from './actions/archive-packaging.action';
import { CreatePackagingAction } from './actions/create-packaging.action';
import { FindAllPackagingsAction } from './actions/find-all-packagings.action';
import { UpdatePackagingAction } from './actions/update-packaging.action';
import { Packaging } from './entities/packaging.entity';
import { PackagingsController } from './packagings.controller';
import { PackagingsService } from './packagings.service';

/**
 * Módulo `packagings` — Fase 3.
 *
 * Cablea las 4 actions del dominio + el service facade.
 *
 * `TypeOrmModule` se exporta para que `ProductsModule` (también Fase 3)
 * pueda inyectar el repositorio de `Packaging` sin reabrir `forFeature`.
 * Patrón espejo del `EmployeesModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Packaging])],
  controllers: [PackagingsController],
  providers: [
    PackagingsService,
    FindAllPackagingsAction,
    CreatePackagingAction,
    UpdatePackagingAction,
    ArchivePackagingAction,
  ],
  exports: [PackagingsService, TypeOrmModule],
})
export class PackagingsModule {}
