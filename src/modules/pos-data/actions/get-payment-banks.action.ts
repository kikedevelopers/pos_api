import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';

export interface PosPaymentBank {
  id: number;
  name: string;
}

/**
 * `GET /pos-data/payment-banks`. Bancos habilitados para cobrar en POS.
 *
 * Espejo PlacePos: `available_in_pos = true AND is_archived = false`.
 *
 * Multi-tenancy: `where: { company_id }`.
 */
@Injectable()
export class GetPaymentBanksAction {
  constructor(
    @InjectRepository(Bank)
    private readonly bankRepo: Repository<Bank>,
  ) {}

  async execute(companyId: number): Promise<PosPaymentBank[]> {
    const banks = await this.bankRepo.find({
      where: {
        company_id: String(companyId),
        available_in_pos: true,
        is_archived: false,
      },
      select: { id: true, name: true },
      order: { name: 'ASC' },
    });
    return banks.map((b) => ({ id: Number(b.id), name: b.name }));
  }
}
