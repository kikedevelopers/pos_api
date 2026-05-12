import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Wallet } from '../entities/wallet.entity';
import { findWalletInCompany } from '../internal/wallet-lookups';

/**
 * Archive (soft-delete) una wallet. Idempotente.
 */
@Injectable()
export class ArchiveWalletAction {
  private readonly logger = new Logger(ArchiveWalletAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, actorId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const wallet = await findWalletInCompany(manager, id, companyId);
      if (wallet.is_archived === true) {
        return;
      }
      await manager.update(
        Wallet,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );
    });

    this.logger.log({
      event: 'wallet.archived',
      companyId,
      walletId: id,
      actorId,
    });
  }
}
