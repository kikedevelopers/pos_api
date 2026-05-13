import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { CreditNote, OperationType } from '../entities/credit-note.entity';
import { findNoteInCompany } from '../internal/credit-note-lookups';

/**
 * Soft-delete de una nota crédito/débito.
 *
 * IMPORTANTE: PlacePos NO expone este endpoint públicamente. Lo añadimos
 * como capacidad administrativa (`owner` only) por si una nota se creó por
 * error y debe revertirse. Reglas:
 *
 *   - Solo se permite anular notas creadas hace menos de `MAX_AGE_HOURS` (24h)
 *     — para impedir reescribir histórico contable consolidado.
 *
 *   - NO revierte automáticamente los side-effects del crear (ajuste de
 *     Customer.balance, FinancialMovements, SaleCredit, reverse de pagos).
 *     El operador debe registrar manualmente la compensación contable.
 *     Para mantener integridad: cuando una nota se soft-deletea, su
 *     `is_deleted = true` permite que el `idx_credit_notes_one_full_void_per_sale`
 *     deje crear una nueva FULL_VOID si fuera necesario.
 *
 *   - Si se necesita compensar (revertir balances), debe hacerse con una
 *     nota inversa: si la nota era CREDIT, crea DEBIT; si era DEBIT, crea
 *     CREDIT (futura mejora — fuera de esta fase).
 */
@Injectable()
export class SoftDeleteCreditNoteAction {
  private readonly logger = new Logger(SoftDeleteCreditNoteAction.name);
  private static readonly MAX_AGE_HOURS = 24;

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, actorId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const note = await findNoteInCompany(manager, id, companyId, {
        requireActive: true,
        lock: true,
      });

      // CRIT-2 auditoría: prohibir soft-delete de FULL_VOID. El índice parcial
      // `idx_credit_notes_one_full_void_per_sale` cuenta solo notas con
      // is_deleted=false; si permitimos soft-delete, el slot único se libera
      // y un segundo FULL_VOID sobre la misma venta volvería a ejecutar
      // `reverseSalePayments` → doble débito de bank/wallet/caja. La regla
      // contable correcta es crear una nota DEBIT compensatoria, NO borrar
      // la FULL_VOID original.
      if (note.operation_type === OperationType.FULL_VOID) {
        throw new UnprocessableEntityException({
          message:
            'No se puede anular una nota FULL_VOID. Crea una nota compensatoria (DEBIT/ADDITION) si necesitas revertirla.',
          payload: { code: 'FULL_VOID_NOT_DELETABLE' },
        });
      }

      const ageHours = (Date.now() - note.created_at.getTime()) / (1000 * 60 * 60);
      if (ageHours > SoftDeleteCreditNoteAction.MAX_AGE_HOURS) {
        throw new UnprocessableEntityException({
          message:
            'La nota fue creada hace más de 24 horas y no puede anularse. Crea una nota compensatoria.',
          payload: { code: 'CREDIT_NOTE_TOO_OLD_TO_DELETE' },
        });
      }

      await manager.update(
        CreditNote,
        { id: note.id, company_id: String(companyId) },
        { is_deleted: true },
      );

      this.logger.log({
        event: 'credit_note.soft_deleted',
        companyId,
        noteId: Number(note.id),
        noteNumber: note.note_number,
        noteType: note.note_type,
        operationType: note.operation_type,
        saleInvoiceId: Number(note.sale_invoice_id),
        total: note.total,
        actorId,
        ageHours,
      });
    });
  }
}
