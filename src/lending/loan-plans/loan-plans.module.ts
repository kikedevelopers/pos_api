import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PosLendingIntegrationModule } from '@/lending/integration/pos/pos-lending-integration.module';

import { CreateLoanPlanAction } from './actions/create-loan-plan.action';
import { FindAllLoanPlansAction } from './actions/find-all-loan-plans.action';
import { FindLoanPlanAction } from './actions/find-loan-plan.action';
import { SetLoanPlanArchivedAction } from './actions/set-loan-plan-archived.action';
import { UpdateLoanPlanAction } from './actions/update-loan-plan.action';
import { LoanPlan } from './entities/loan-plan.entity';
import { LoanPlansController } from './loan-plans.controller';
import { LoanPlansService } from './loan-plans.service';

/**
 * Planes de préstamo. Los guards (tenant prestamista, nivel administrador)
 * resuelven sus dependencias por `PosLendingIntegrationModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LoanPlan]), PosLendingIntegrationModule],
  controllers: [LoanPlansController],
  providers: [
    LoanPlansService,
    FindAllLoanPlansAction,
    FindLoanPlanAction,
    CreateLoanPlanAction,
    UpdateLoanPlanAction,
    SetLoanPlanArchivedAction,
  ],
})
export class LoanPlansModule {}
