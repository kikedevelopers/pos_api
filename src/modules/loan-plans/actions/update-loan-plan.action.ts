import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { UpdateLoanPlanDto } from '../dto/update-loan-plan.dto';
import { LoanPlan } from '../entities/loan-plan.entity';
import { translateLoanPlanConstraintError } from '../internal/constraint-errors';
import { normalizeLoanPlan } from '../internal/loan-plan-rules';
import { FindLoanPlanAction } from './find-loan-plan.action';

/**
 * Edita un plan (`PUT /loan-plans/:id`). El cambio parcial se MEZCLA con el
 * plan guardado y se valida el resultado completo: así no se puede dejar, por
 * ejemplo, una cuota diaria sin días de cobro cambiando solo el tipo.
 *
 * Editar el plan no toca préstamos ya hechos: cada préstamo guardará su copia
 * de las condiciones con las que se prestó.
 */
@Injectable()
export class UpdateLoanPlanAction {
  constructor(
    @InjectRepository(LoanPlan)
    private readonly repo: Repository<LoanPlan>,
    private readonly findOne: FindLoanPlanAction,
  ) {}

  async execute(id: number, dto: UpdateLoanPlanDto, companyId: number): Promise<LoanPlan> {
    const current = await this.findOne.execute(id, companyId);

    const merged = normalizeLoanPlan({
      name: dto.name ?? current.name,
      description: dto.description !== undefined ? dto.description : current.description,
      plan_type: dto.plan_type ?? current.plan_type,
      interest_rate: dto.interest_rate ?? current.interest_rate,
      rate_period: dto.rate_period ?? current.rate_period,
      installments_count:
        dto.installments_count !== undefined ? dto.installments_count : current.installments_count,
      collection_days:
        dto.collection_days !== undefined ? dto.collection_days : current.collection_days,
    });

    try {
      return await this.repo.save({
        ...current,
        ...merged,
        interest_rate: String(merged.interest_rate),
      });
    } catch (error) {
      translateLoanPlanConstraintError(error);
      throw error;
    }
  }
}
