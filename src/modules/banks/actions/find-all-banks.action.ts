import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';

/**
 * Lista banks ACTIVOS (`is_archived = false`) de una company, ordenados
 * por `created_at DESC`. Endpoint `GET /banks`.
 *
 * Paridad PlacePos byte-por-byte (`banks.routes.ts`):
 *   `ORDER BY created_at DESC`.
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class FindAllBanksAction {
  constructor(
    @InjectRepository(Bank)
    private readonly repo: Repository<Bank>,
  ) {}

  async execute(companyId: number): Promise<Bank[]> {
    return this.repo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { created_at: 'DESC' },
    });
  }
}
