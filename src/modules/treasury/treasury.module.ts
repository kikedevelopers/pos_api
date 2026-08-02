import { Module } from '@nestjs/common';

import { GetTreasuryAccountsAction } from './actions/get-treasury-accounts.action';
import { ListTreasuryMovementsAction } from './actions/list-treasury-movements.action';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';

/**
 * Módulo `treasury` (Resumen de tesorería).
 *
 * No requiere `TypeOrmModule.forFeature`: las actions leen vía el `DataSource`
 * global (repositorio de `FinancialMovement` + queries raw a banks/wallets/
 * cash_registers), igual que `GetTodayAction`. Reutiliza `fetchCashAccounts`
 * (`dashboard/internal`) para los saldos.
 */
@Module({
  controllers: [TreasuryController],
  providers: [TreasuryService, GetTreasuryAccountsAction, ListTreasuryMovementsAction],
  // `AiModule` consulta los saldos consolidados como herramienta del asistente.
  exports: [TreasuryService],
})
export class TreasuryModule {}
