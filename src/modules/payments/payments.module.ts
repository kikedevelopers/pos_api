import { Module } from '@nestjs/common';

import { ListAllPaymentsAction } from './actions/list-all-payments.action';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Módulo `payments` (Fase 9). Agregador read-only sobre `sale_payments` +
 * `purchase_payments`. Sin entidad propia, sin migración: solo vista
 * combinada vía UNION ALL.
 *
 * No depende de `SalesModule`/`PurchasesModule` — usa SQL crudo via
 * `DataSource.query()` para evitar acoplamientos transitivos.
 */
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, ListAllPaymentsAction],
  exports: [PaymentsService],
})
export class PaymentsModule {}
