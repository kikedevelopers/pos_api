import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppAlert } from '@/modules/app-alerts/entities/app-alert.entity';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { BanksModule } from '@/modules/banks/banks.module';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { Expense } from '@/modules/expenses/entities/expense.entity';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { RealtimeModule } from '@/modules/realtime/realtime.module';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { ArchiveFixedExpenseAction } from './actions/archive-fixed-expense.action';
import { CreateFixedExpenseAction } from './actions/create-fixed-expense.action';
import { FindAllFixedExpensesAction } from './actions/find-all-fixed-expenses.action';
import { FindFixedExpenseAction } from './actions/find-fixed-expense.action';
import { ListFixedExpensePeriodsAction } from './actions/list-fixed-expense-periods.action';
import { MarkFixedExpensePeriodPaidAction } from './actions/mark-fixed-expense-period-paid.action';
import { PayFixedExpensePeriodsAction } from './actions/pay-fixed-expense-periods.action';
import { SyncDuePeriodsAction } from './actions/sync-due-periods.action';
import { UpdateFixedExpenseAction } from './actions/update-fixed-expense.action';
import { FixedExpensePeriod } from './entities/fixed-expense-period.entity';
import { FixedExpense } from './entities/fixed-expense.entity';
import { FixedExpensesController } from './fixed-expenses.controller';
import { FixedExpensesService } from './fixed-expenses.service';

/**
 * Módulo `fixed-expenses` (Ola 2B). Catálogo de gastos recurrentes + cortes
 * vencidos.
 *
 * Espejo de PlacePos `fixed-expenses.routes.ts` y entidades
 * `FixedExpense` / `FixedExpensePeriod`, adaptado a multi-tenant.
 *
 * Dependencias: ninguna externa por ahora. En futuras olas se conectará con
 * `ExpensesModule` (registrar el `Expense` real al pagar un corte) y con
 * `AppAlertsModule` (alerta por corte vencido).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      FixedExpense,
      FixedExpensePeriod,
      AppAlert,
      Expense,
      Bank,
      Wallet,
      CashRegister,
    ]),
    BanksModule,
    WalletsModule,
    CashRegisterModule,
    FinancialMovementsModule,
    RealtimeModule,
  ],
  controllers: [FixedExpensesController],
  providers: [
    FixedExpensesService,
    FindAllFixedExpensesAction,
    FindFixedExpenseAction,
    CreateFixedExpenseAction,
    UpdateFixedExpenseAction,
    ArchiveFixedExpenseAction,
    ListFixedExpensePeriodsAction,
    MarkFixedExpensePeriodPaidAction,
    PayFixedExpensePeriodsAction,
    SyncDuePeriodsAction,
  ],
  exports: [FixedExpensesService, TypeOrmModule],
})
export class FixedExpensesModule {}
