import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Wallet } from '@/modules/wallets/entities/wallet.entity';

/**
 * Lista wallets ACTIVAS (`is_archived = false`) de una company, ordenadas
 * por `created_at DESC`. Endpoint `GET /wallets`. Espejo PlacePos.
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class FindAllWalletsAction {
  constructor(
    @InjectRepository(Wallet)
    private readonly repo: Repository<Wallet>,
  ) {}

  async execute(companyId: number): Promise<Wallet[]> {
    return this.repo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { created_at: 'DESC' },
    });
  }
}
