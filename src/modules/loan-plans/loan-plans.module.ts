import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RolesModule } from '@/modules/roles/roles.module';

import { CreateLoanPlanAction } from './actions/create-loan-plan.action';
import { FindAllLoanPlansAction } from './actions/find-all-loan-plans.action';
import { FindLoanPlanAction } from './actions/find-loan-plan.action';
import { SetLoanPlanArchivedAction } from './actions/set-loan-plan-archived.action';
import { UpdateLoanPlanAction } from './actions/update-loan-plan.action';
import { LoanPlan } from './entities/loan-plan.entity';
import { LoanPlansController } from './loan-plans.controller';
import { LoanPlansService } from './loan-plans.service';

/**
 * Módulo `loan-plans` — planes de préstamo del modo prestamista. `RolesModule`
 * aporta `ResolveEffectivePermissionsAction` para el `AdminLevelGuard`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LoanPlan]), RolesModule],
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
