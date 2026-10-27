import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { LENDING_CUSTOMERS, type LendingCustomersPort } from '@/lending/ports/lending-customers.port';

import { Loan, type LoanStatus } from '../entities/loan.entity';

export interface LoanFilters {
  status?: LoanStatus;
  customerId?: number;
}

export interface LoansWithCustomers {
  loans: Loan[];
  customerNames: Map<number, string>;
}

/**
 * Cartera de préstamos (`GET /loans`): los de la company, el más reciente
 * primero. Los nombres de los clientes se piden en UNA consulta al puerto de
 * clientes (no hay join con tablas del POS).
 */
@Injectable()
export class FindAllLoansAction {
  constructor(
    @InjectRepository(Loan)
    private readonly repo: Repository<Loan>,
    @Inject(LENDING_CUSTOMERS) private readonly customers: LendingCustomersPort,
  ) {}

  async execute(companyId: number, filters: LoanFilters = {}): Promise<LoansWithCustomers> {
    const loans = await this.repo.find({
      where: {
        company_id: String(companyId),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.customerId ? { customer_id: String(filters.customerId) } : {}),
      },
      order: { created_at: 'DESC', id: 'DESC' },
    });
    const customerNames = await this.customers.namesByIds(
      companyId,
      loans.map((loan) => Number(loan.customer_id)),
    );
    return { loans, customerNames };
  }
}
