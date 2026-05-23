import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { FixedExpense } from '../entities/fixed-expense.entity';

/**
 * Archiva (soft-delete) un FixedExpense.
 *
 * Paridad PlacePos `PUT /fixed-expenses/:id/archive`. Solo afecta el flag
 * `is_archived`; NO toca los cortes históricos ya generados, que mantienen
 * su status original (PAID / PENDING). Si en el futuro se decide cancelar
 * cortes pendientes al archivar el padre, esa lógica vive aquí dentro de
 * la misma tx.
 *
 * §8.8: mutación en transacción.
 */
@Injectable()
export class ArchiveFixedExpenseAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(FixedExpense, {
        where: { id: String(id), company_id: String(companyId), is_archived: false },
      });
      if (!existing) {
        throw new NotFoundException('Gasto fijo no encontrado.');
      }
      await manager.update(
        FixedExpense,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );
    });
  }
}
