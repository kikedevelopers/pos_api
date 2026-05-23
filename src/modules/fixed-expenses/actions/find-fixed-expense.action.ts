import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { FixedExpense } from '../entities/fixed-expense.entity';

/**
 * Resuelve un FixedExpense por id dentro de la company. Si no existe o
 * pertenece a otro tenant → 404 (sin filtrar la existencia del recurso).
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class FindFixedExpenseAction {
  constructor(
    @InjectRepository(FixedExpense)
    private readonly repo: Repository<FixedExpense>,
  ) {}

  async execute(id: number, companyId: number): Promise<FixedExpense> {
    const row = await this.repo.findOne({
      where: { id: String(id), company_id: String(companyId) },
    });
    if (!row) {
      throw new NotFoundException('Gasto fijo no encontrado.');
    }
    return row;
  }
}
