import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { LoanPlan } from '../entities/loan-plan.entity';

/**
 * Lista los planes de préstamo de la company (`GET /loan-plans`). Por defecto
 * solo los activos; con `includeArchived` también los archivados. Orden:
 * activos primero, luego por nombre (lo que espera el selector del préstamo).
 */
@Injectable()
export class FindAllLoanPlansAction {
  constructor(
    @InjectRepository(LoanPlan)
    private readonly repo: Repository<LoanPlan>,
  ) {}

  execute(companyId: number, includeArchived = false): Promise<LoanPlan[]> {
    return this.repo.find({
      where: {
        company_id: String(companyId),
        ...(includeArchived ? {} : { is_archived: false }),
      },
      order: { is_archived: 'ASC', name: 'ASC', id: 'ASC' },
    });
  }
}
