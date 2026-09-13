import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ElectronicBillingGuard } from '@/common/guards/electronic-billing.guard';

import { TaxRate } from './entities/tax-rate.entity';
import { TaxesController } from './taxes.controller';
import { TaxesService } from './taxes.service';

/**
 * Catálogo global de tarifas de IVA. Exporta `TaxesService` y el repositorio de
 * `TaxRate` para que el módulo de productos resuelva la tarifa de un producto al
 * calcular el desglose base/IVA de sus precios.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TaxRate])],
  controllers: [TaxesController],
  providers: [TaxesService, ElectronicBillingGuard],
  exports: [TaxesService, TypeOrmModule],
})
export class TaxesModule {}
