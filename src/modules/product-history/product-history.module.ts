import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FindCostHistoryAction } from './actions/find-cost-history.action';
import { FindPriceHistoryAction } from './actions/find-price-history.action';
import { ProductCostHistory } from './entities/product-cost-history.entity';
import { ProductPriceHistory } from './entities/product-price-history.entity';
import { ProductCostHistoryController } from './product-cost-history.controller';
import { ProductHistoryService } from './product-history.service';
import { ProductPriceHistoryController } from './product-price-history.controller';

/**
 * Módulo `product-history` — Fase 2A.
 *
 * Dos controllers en rutas absolutas:
 *   - `/products/:id/cost-history`
 *   - `/product-prices/:id/price-history`
 *
 * Exporta `TypeOrmModule` para que Fase 5+ (purchaseReceiveOperations)
 * pueda hacer INSERT en las tablas de historial.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProductCostHistory, ProductPriceHistory])],
  controllers: [ProductCostHistoryController, ProductPriceHistoryController],
  providers: [ProductHistoryService, FindCostHistoryAction, FindPriceHistoryAction],
  exports: [ProductHistoryService, TypeOrmModule],
})
export class ProductHistoryModule {}
