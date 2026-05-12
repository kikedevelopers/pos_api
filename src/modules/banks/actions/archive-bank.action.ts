import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Bank } from '../entities/bank.entity';
import { findBankInCompany } from '../internal/bank-lookups';

/**
 * Archive (soft-delete) un bank. Setea `is_archived = true`. Idempotente:
 * archivar un bank ya archivado responde 200 sin error.
 *
 * Razón de NO borrar físicamente:
 *   - SalePayment / FinancialMovement / PurchasePayment históricos
 *     pueden referenciar al bank por id. Una eliminación física rompería
 *     reportes históricos.
 *
 * Transacción: §8.8 — defensa en profundidad por si en el futuro
 * añadimos triggers / side effects al archivar.
 */
@Injectable()
export class ArchiveBankAction {
  private readonly logger = new Logger(ArchiveBankAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, actorId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const bank = await findBankInCompany(manager, id, companyId);
      if (bank.is_archived === true) {
        // Idempotente: ya está archivado, no hacemos nada.
        return;
      }
      await manager.update(
        Bank,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );
    });

    this.logger.log({
      event: 'bank.archived',
      companyId,
      bankId: id,
      actorId,
    });
  }
}
