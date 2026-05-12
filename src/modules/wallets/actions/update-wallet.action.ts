import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateWalletDto } from '../dto/update-wallet.dto';
import { Wallet } from '../entities/wallet.entity';
import { translateWalletConstraintError } from '../internal/constraint-errors';
import { findWalletInCompany } from '../internal/wallet-lookups';

/**
 * Actualiza el `name` de una wallet. Espejo PlacePos `PUT /wallets/:id`.
 *
 * Filtra `is_archived = false` previo al update — no permite renombrar
 * billeteras archivadas.
 *
 * `name` duplicado → 400 con mensaje literal de PlacePos.
 */
@Injectable()
export class UpdateWalletAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, dto: UpdateWalletDto, companyId: number): Promise<Wallet> {
    return this.dataSource.transaction<Wallet>(async (manager) => {
      await findWalletInCompany(manager, id, companyId, { requireActive: true });

      try {
        await manager.update(
          Wallet,
          { id: String(id), company_id: String(companyId) },
          { name: dto.name },
        );
      } catch (error) {
        translateWalletConstraintError(error);
        throw error;
      }

      return findWalletInCompany(manager, id, companyId);
    });
  }
}
