import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Loan } from '../entities/loan.entity';

/** Un préstamo de la company (`GET /loans/:id`). 404 genérico cross-tenant. */
@Injectable()
export class FindLoanAction {
  constructor(
    @InjectRepository(Loan)
    private readonly repo: Repository<Loan>,
  ) {}

  async execute(id: number, companyId: number): Promise<Loan> {
    const loan = await this.repo.findOne({
      where: { id: String(id), company_id: String(companyId) },
      relations: { customer: true },
    });
    if (!loan) throw new NotFoundException('Préstamo no encontrado.');
    return loan;
  }
}
