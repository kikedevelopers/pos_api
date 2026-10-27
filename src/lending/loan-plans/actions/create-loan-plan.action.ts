import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { CreateLoanPlanDto } from '../dto/create-loan-plan.dto';
import { LoanPlan } from '../entities/loan-plan.entity';
import { translateLoanPlanConstraintError } from '../internal/constraint-errors';
import { normalizeLoanPlan } from '../../domain/loan-plan-rules';

export interface LoanPlanActor {
  id: number;
  fullName: string;
}

/**
 * Crea un plan de préstamo (`POST /loan-plans`). Reglas por tipo → 400;
 * nombre repetido entre los activos → 409. Auditoría desde el actor.
 */
@Injectable()
export class CreateLoanPlanAction {
  private readonly logger = new Logger(CreateLoanPlanAction.name);

  constructor(
    @InjectRepository(LoanPlan)
    private readonly repo: Repository<LoanPlan>,
  ) {}

  async execute(dto: CreateLoanPlanDto, companyId: number, actor: LoanPlanActor): Promise<LoanPlan> {
    const plan = normalizeLoanPlan(dto);

    let saved: LoanPlan;
    try {
      saved = await this.repo.save(
        this.repo.create({
          ...plan,
          interest_rate: String(plan.interest_rate),
          company_id: String(companyId),
          is_archived: false,
          created_by: actor.fullName,
          created_by_id: String(actor.id),
        }),
      );
    } catch (error) {
      translateLoanPlanConstraintError(error);
      throw error;
    }

    this.logger.log({
      event: 'loan_plan.created',
      actorId: actor.id,
      companyId,
      loanPlanId: Number(saved.id),
      planType: plan.plan_type,
    });
    return saved;
  }
}
