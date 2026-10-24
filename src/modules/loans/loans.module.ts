import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { RolesModule } from '@/modules/roles/roles.module';

import { CreateLoanAction } from './actions/create-loan.action';
import { FindAllLoansAction } from './actions/find-all-loans.action';
import { FindLoanAction } from './actions/find-loan.action';
import { Loan } from './entities/loan.entity';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';

/**
 * Módulo `loans` — préstamos del modo prestamista. `FinancialMovementsModule`
 * registra el desembolso desde banco/billetera; `RolesModule` aporta lo que
 * necesita el `AdminLevelGuard`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Loan]), FinancialMovementsModule, RolesModule],
  controllers: [LoansController],
  providers: [LoansService, FindAllLoansAction, FindLoanAction, CreateLoanAction],
})
export class LoansModule {}
