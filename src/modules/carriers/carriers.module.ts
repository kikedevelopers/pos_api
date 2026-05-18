import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ArchiveCarrierAction } from './actions/archive-carrier.action';
import { CreateCarrierAction } from './actions/create-carrier.action';
import { FindAllCarriersAction } from './actions/find-all-carriers.action';
import { FindCarrierAction } from './actions/find-carrier.action';
import { GetCarriersAnalyticsAction } from './actions/get-carriers-analytics.action';
import { UpdateCarrierAction } from './actions/update-carrier.action';
import { CarriersController } from './carriers.controller';
import { CarriersService } from './carriers.service';
import { Carrier } from './entities/carrier.entity';
import { CarrierCredit } from './entities/carrier-credit.entity';

/**
 * Módulo `carriers` — Fase 2A.
 *
 * Exporta `TypeOrmModule` para que `CarrierPaymentsModule` (depende de
 * `CarrierCredit` y `Carrier` para cargar credits/locks) pueda inyectar sus
 * repositorios sin redeclararlos.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Carrier, CarrierCredit])],
  controllers: [CarriersController],
  providers: [
    CarriersService,
    FindAllCarriersAction,
    FindCarrierAction,
    GetCarriersAnalyticsAction,
    CreateCarrierAction,
    UpdateCarrierAction,
    ArchiveCarrierAction,
  ],
  exports: [CarriersService, TypeOrmModule],
})
export class CarriersModule {}
