import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';
import { SalesModule } from '@/modules/sales/sales.module';

import { ArchiveDeliveryAction } from './actions/archive-delivery.action';
import { CreateDeliveryAction } from './actions/create-delivery.action';
import { CreateDeliveryCompanyAction } from './actions/create-delivery-company.action';
import { FindAllDeliveriesAction } from './actions/find-all-deliveries.action';
import { FindAllDeliveryCompaniesAction } from './actions/find-all-delivery-companies.action';
import { FindDeliveryAction } from './actions/find-delivery.action';
import { FindDeliveryByInvoiceAction } from './actions/find-delivery-by-invoice.action';
import { FindDeliveryCompanyAction } from './actions/find-delivery-company.action';
import { PrefillDeliveryAction } from './actions/prefill-delivery.action';
import { ToggleDeliveryCompanyArchiveAction } from './actions/toggle-delivery-company-archive.action';
import { UpdateDeliveryCompanyAction } from './actions/update-delivery-company.action';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';
import { DeliveryCompaniesController } from './delivery-companies.controller';
import { Delivery } from './entities/delivery.entity';
import { DeliveryCompany } from './entities/delivery-company.entity';

/**
 * Módulo `deliveries` (Domiciliarios). Espejo cloud del feature de PlacePos.
 *
 * Cubre dos sub-dominios:
 *   - `delivery_companies` — catálogo de domiciliarios (CRUD + archive).
 *   - `deliveries`        — domicilios/entregas (registro + anulación con
 *     reverso de caja).
 *
 * Dependencias:
 *   - `CashRegisterModule`: para el egreso 'pagado de caja' (resolución de la
 *     caja del cajero + CashRegisterLog). Se reusa el helper
 *     `getOrCreateCashRegisterForUser` y las entidades CashRegister/Log que
 *     ese módulo registra y exporta.
 *   - `SalesModule`: para resolver la venta en `prefill` y al ligar un
 *     domicilio a una venta. Registramos `SaleInvoice` localmente vía
 *     `forFeature` para inyectar su Repository en `PrefillDeliveryAction`.
 *
 * NOTA enum caja: este módulo usa `CashRegisterLogType.DELIVERY_PAYMENT` /
 * `VOID_DELIVERY_PAYMENT`, añadidos al enum PG `cash_register_log_type` por la
 * migración `1747011040000-add-delivery-cash-register-log-types`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DeliveryCompany, Delivery, SaleInvoice]),
    CashRegisterModule,
    SalesModule,
  ],
  controllers: [DeliveryCompaniesController, DeliveriesController],
  providers: [
    DeliveriesService,
    // delivery-companies
    FindAllDeliveryCompaniesAction,
    FindDeliveryCompanyAction,
    CreateDeliveryCompanyAction,
    UpdateDeliveryCompanyAction,
    ToggleDeliveryCompanyArchiveAction,
    // deliveries
    FindAllDeliveriesAction,
    FindDeliveryAction,
    FindDeliveryByInvoiceAction,
    PrefillDeliveryAction,
    CreateDeliveryAction,
    ArchiveDeliveryAction,
  ],
  exports: [DeliveriesService, TypeOrmModule],
})
export class DeliveriesModule {}
