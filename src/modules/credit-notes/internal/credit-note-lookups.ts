import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { CorrectionSource } from '../entities/correction-source.entity';
import { CreditNoteLine } from '../entities/credit-note-line.entity';
import { CreditNote, OperationType } from '../entities/credit-note.entity';

/**
 * Helpers internos del módulo `credit-notes`. Centralizan la lectura del
 * agregado (note + lines + correction_source) dentro de la company.
 *
 * Diseño espejo de `sales/internal/sale-lookups.ts`.
 */

/**
 * Lookup por id dentro de una company. `options.requireActive = true` filtra
 * `is_deleted = false` (default true).
 */
export async function findNoteInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
  options: { requireActive?: boolean; lock?: boolean } = {},
): Promise<CreditNote> {
  const where: { id: string; company_id: string; is_deleted?: boolean } = {
    id: String(id),
    company_id: String(companyId),
  };
  if (options.requireActive !== false) {
    where.is_deleted = false;
  }

  const note = await manager.findOne(CreditNote, {
    where,
    ...(options.lock === true ? { lock: { mode: 'pessimistic_write' as const } } : {}),
  });
  if (!note) {
    throw new NotFoundException('Nota no encontrada');
  }
  return note;
}

export async function findNoteLines(
  manager: EntityManager,
  noteId: number,
  companyId: number,
): Promise<CreditNoteLine[]> {
  return manager.find(CreditNoteLine, {
    where: { credit_note_id: String(noteId), company_id: String(companyId) },
    order: { id: 'ASC' },
  });
}

export async function findNoteCorrectionSource(
  manager: EntityManager,
  noteId: number,
  companyId: number,
): Promise<CorrectionSource | null> {
  return manager.findOne(CorrectionSource, {
    where: { credit_note_id: String(noteId), company_id: String(companyId) },
  });
}

/**
 * Cuenta cuántas notas FULL_VOID activas existen ya sobre una venta. Se usa
 * para enforzar la invariante "una sola FULL_VOID por venta" antes del INSERT.
 *
 * El UNIQUE parcial en migración es la red de seguridad — pero validar acá
 * permite devolver un 422 legible en lugar de un 23505 confuso.
 */
export async function countActiveFullVoids(
  manager: EntityManager,
  saleInvoiceId: number,
  companyId: number,
): Promise<number> {
  return manager.count(CreditNote, {
    where: {
      sale_invoice_id: String(saleInvoiceId),
      company_id: String(companyId),
      operation_type: OperationType.FULL_VOID,
      is_deleted: false,
    },
  });
}

/**
 * Suma de cantidades ya anuladas por línea original (PARTIAL_VOID activas).
 * Se usa para validar que una nueva nota PARTIAL_VOID no exceda la qty
 * original de cada `sale_invoice_lines.id`.
 *
 * Retorna un Map<original_line_id, quantity_ya_anulada>.
 *
 * Solo cuenta notas no anuladas (`is_deleted = false`) — las eliminadas no
 * "queman" cantidad disponible.
 */
export async function sumPartialVoidedQuantitiesByLine(
  manager: EntityManager,
  saleInvoiceId: number,
  companyId: number,
): Promise<Map<number, string>> {
  const rows: Array<{ original_line_id: string | null; total_quantity: string | null }> =
    await manager
      .createQueryBuilder(CreditNoteLine, 'cnl')
      .innerJoin(CreditNote, 'cn', 'cn.id = cnl.credit_note_id')
      .select('cnl.original_line_id', 'original_line_id')
      .addSelect('SUM(cnl.quantity)', 'total_quantity')
      .where('cnl.company_id = :companyId', { companyId: String(companyId) })
      .andWhere('cn.company_id = :companyId', { companyId: String(companyId) })
      .andWhere('cn.sale_invoice_id = :saleId', { saleId: String(saleInvoiceId) })
      .andWhere('cn.operation_type = :op', { op: OperationType.PARTIAL_VOID })
      .andWhere('cn.is_deleted = false')
      .andWhere('cnl.original_line_id IS NOT NULL')
      .groupBy('cnl.original_line_id')
      .getRawMany();

  const map = new Map<number, string>();
  for (const row of rows) {
    if (row.original_line_id !== null && row.total_quantity !== null) {
      map.set(Number(row.original_line_id), row.total_quantity);
    }
  }
  return map;
}
