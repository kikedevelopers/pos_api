import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { LoanPlan } from '../entities/loan-plan.entity';
import { translateLoanPlanConstraintError } from '../internal/constraint-errors';
import { FindLoanPlanAction } from './find-loan-plan.action';

/**
 * Archiva o restaura un plan (`PUT /loan-plans/:id/archive`). Archivar lo saca
 * del selector de préstamos sin borrarlo. Restaurar puede chocar con un plan
 * activo del mismo nombre → 409.
 */
@Injectable()
export class SetLoanPlanArchivedAction {
  constructor(
    @InjectRepository(LoanPlan)
    private readonly repo: Repository<LoanPlan>,
    private readonly findOne: FindLoanPlanAction,
  ) {}

  async execute(id: number, isArchived: boolean, companyId: number): Promise<LoanPlan> {
    const plan = await this.findOne.execute(id, companyId);
    if (plan.is_archived === isArchived) return plan;
    try {
      return await this.repo.save({ ...plan, is_archived: isArchived });
    } catch (error) {
      translateLoanPlanConstraintError(error);
      throw error;
    }
  }
}
