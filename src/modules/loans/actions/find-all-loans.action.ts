import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Loan, type LoanStatus } from '../entities/loan.entity';

export interface LoanFilters {
  status?: LoanStatus;
  customerId?: number;
}

/**
 * Cartera de préstamos (`GET /loans`): los de la company, el más reciente
 * primero, con el nombre del cliente. Filtros opcionales por estado y cliente.
 */
@Injectable()
export class FindAllLoansAction {
  constructor(
    @InjectRepository(Loan)
    private readonly repo: Repository<Loan>,
  ) {}

  execute(companyId: number, filters: LoanFilters = {}): Promise<Loan[]> {
    return this.repo.find({
      where: {
        company_id: String(companyId),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.customerId ? { customer_id: String(filters.customerId) } : {}),
      },
      relations: { customer: true },
      order: { created_at: 'DESC', id: 'DESC' },
    });
  }
}
