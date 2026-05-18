import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CreateSupplierAction } from './actions/create-supplier.action';
import { FindAllSuppliersAction } from './actions/find-all-suppliers.action';
import { FindSupplierAction } from './actions/find-supplier.action';
import { GetSupplierPurchasesHistoryAction } from './actions/get-supplier-purchases-history.action';
import { GetSuppliersAnalyticsAction } from './actions/get-suppliers-analytics.action';
import { ToggleSupplierArchiveAction } from './actions/toggle-supplier-archive.action';
import { UpdateSupplierAction } from './actions/update-supplier.action';
import { Supplier } from './entities/supplier.entity';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

/**
 * Módulo `suppliers`. Cablea las 7 actions + service facade.
 *
 *   - Se exporta el service y `TypeOrmModule` para que módulos de fases
 *     futuras (purchases en Fase 8, dashboard, reports) puedan leer suppliers
 *     sin reabrir la registración.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Supplier])],
  controllers: [SuppliersController],
  providers: [
    SuppliersService,
    FindAllSuppliersAction,
    FindSupplierAction,
    CreateSupplierAction,
    UpdateSupplierAction,
    ToggleSupplierArchiveAction,
    GetSupplierPurchasesHistoryAction,
    GetSuppliersAnalyticsAction,
  ],
  exports: [SuppliersService, TypeOrmModule],
})
export class SuppliersModule {}
