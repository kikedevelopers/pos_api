import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { BanksModule } from '@/modules/banks/banks.module';
import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { CreateExpenseAction } from './actions/create-expense.action';
import { FindAllExpensesAction } from './actions/find-all-expenses.action';
import { FindExpenseAction } from './actions/find-expense.action';
import { SoftDeleteExpenseAction } from './actions/soft-delete-expense.action';
import { UpdateExpenseAction } from './actions/update-expense.action';
import { Expense } from './entities/expense.entity';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

/**
 * Módulo `expenses` (Fase 9). Gastos administrativos.
 *
 * Dependencias:
 *   - `BanksModule` / `WalletsModule`: para validar y debitar/acreditar
 *     cuentas origen.
 *   - `CashRegisterModule`: para gastos pagados desde caja (lock del turno
 *     abierto + CashRegisterLog).
 *   - `FinancialMovementsModule`: registra el EXPENSE (bank/wallet) o
 *     ADJUSTMENT (reversión) asociado.
 *
 * Se exporta `ExpensesService` por si `dashboard`/`reports` lo necesita para
 * agregados — el patrón existe en otros módulos.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Expense, Bank, Wallet]),
    BanksModule,
    WalletsModule,
    CashRegisterModule,
    FinancialMovementsModule,
  ],
  controllers: [ExpensesController],
  providers: [
    ExpensesService,
    FindAllExpensesAction,
    FindExpenseAction,
    CreateExpenseAction,
    UpdateExpenseAction,
    SoftDeleteExpenseAction,
  ],
  exports: [ExpensesService, TypeOrmModule],
})
export class ExpensesModule {}
