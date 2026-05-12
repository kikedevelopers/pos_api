import { Module } from '@nestjs/common';

import { ListAllCreditsAction } from './actions/list-all-credits.action';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';

/**
 * Módulo `credits` (Fase 9). Agregador read-only sobre `sale_credits` +
 * `purchase_credits`. NO tiene entidad propia ni migración: solo expone una
 * vista combinada vía UNION ALL.
 *
 * No depende de `SalesModule`/`PurchasesModule` porque la action usa SQL
 * crudo via `DataSource.query()` — evita ciclos y mantiene el módulo
 * mínimamente acoplado.
 */
@Module({
  controllers: [CreditsController],
  providers: [CreditsService, ListAllCreditsAction],
  exports: [CreditsService],
})
export class CreditsModule {}
