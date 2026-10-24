import { Injectable } from '@nestjs/common';

import { CreateLoanPlanAction, type LoanPlanActor } from './actions/create-loan-plan.action';
import { FindAllLoanPlansAction } from './actions/find-all-loan-plans.action';
import { FindLoanPlanAction } from './actions/find-loan-plan.action';
import { SetLoanPlanArchivedAction } from './actions/set-loan-plan-archived.action';
import { UpdateLoanPlanAction } from './actions/update-loan-plan.action';
import type { CreateLoanPlanDto } from './dto/create-loan-plan.dto';
import type { UpdateLoanPlanDto } from './dto/update-loan-plan.dto';
import type { LoanPlan } from './entities/loan-plan.entity';

/** Facade delgado del dominio `loan-plans`. Solo delega a las actions. */
@Injectable()
export class LoanPlansService {
  constructor(
    private readonly findAllAction: FindAllLoanPlansAction,
    private readonly findOneAction: FindLoanPlanAction,
    private readonly createAction: CreateLoanPlanAction,
    private readonly updateAction: UpdateLoanPlanAction,
    private readonly setArchivedAction: SetLoanPlanArchivedAction,
  ) {}

  findAll(companyId: number, includeArchived: boolean): Promise<LoanPlan[]> {
    return this.findAllAction.execute(companyId, includeArchived);
  }

  findOne(id: number, companyId: number): Promise<LoanPlan> {
    return this.findOneAction.execute(id, companyId);
  }

  create(dto: CreateLoanPlanDto, companyId: number, actor: LoanPlanActor): Promise<LoanPlan> {
    return this.createAction.execute(dto, companyId, actor);
  }

  update(id: number, dto: UpdateLoanPlanDto, companyId: number): Promise<LoanPlan> {
    return this.updateAction.execute(id, dto, companyId);
  }

  setArchived(id: number, isArchived: boolean, companyId: number): Promise<LoanPlan> {
    return this.setArchivedAction.execute(id, isArchived, companyId);
  }
}
