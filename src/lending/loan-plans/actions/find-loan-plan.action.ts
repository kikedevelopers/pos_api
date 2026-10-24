import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { LoanPlan } from '../entities/loan-plan.entity';

/**
 * Un plan de la company (`GET /loan-plans/:id`). 404 genérico si no existe o
 * es de otra company (anti-enumeración cross-tenant).
 */
@Injectable()
export class FindLoanPlanAction {
  constructor(
    @InjectRepository(LoanPlan)
    private readonly repo: Repository<LoanPlan>,
  ) {}

  async execute(id: number, companyId: number): Promise<LoanPlan> {
    const plan = await this.repo.findOne({
      where: { id: String(id), company_id: String(companyId) },
    });
    if (!plan) throw new NotFoundException('Plan de préstamo no encontrado.');
    return plan;
  }
}
