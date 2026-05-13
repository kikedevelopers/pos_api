import Big from 'big.js';

import { toBig } from '@/common/utils/precision';

/**
 * Helpers compartidos entre `GET /pos-reports/sales` y `/pos-reports/dashboard-sales`.
 * Mantienen el shape de salida idéntico a PlacePos.
 */

export interface NoteRow {
  id: string;
  note_number: string;
  note_type: string;
  operation_type: string;
  sale_invoice_id: string;
  total: number;
  note_cost: number;
  created_by: string | null;
  created_at: Date;
  parent_ticket_number: string;
  parent_sale_number: string | null;
  customer_name: string | null;
}

export const round2 = (n: unknown): number => Number(toBig(n).round(2).toString());

export const calcProfit = (total: unknown, cost: unknown): number =>
  round2(toBig(total).minus(toBig(cost)).toNumber());

export const calcMargin = (total: unknown, cost: unknown): number => {
  const t = toBig(total);
  if (t.lte(0)) {
    return 0;
  }
  return round2(t.minus(toBig(cost)).div(t).times(100).toNumber());
};

export function toIsoStr(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

/**
 * Mapea una nota a la forma "ticket de tipo NOTE" que el listado mezcla con
 * las invoices. `consolidatedTotal` es signed (CREDIT resta).
 */
export function mapNoteToTicket(note: NoteRow): Record<string, unknown> {
  const noteCost = Number(note.note_cost) || 0;
  const noteProfit = calcProfit(note.total, noteCost);
  const noteMargin = calcMargin(note.total, noteCost);

  return {
    id: Number(note.id),
    rowType: 'NOTE',
    ticketType: 'NOTE',
    ticketNumber: note.note_number,
    saleNumber: null,
    originalTotal: Number(note.total),
    consolidatedTotal: note.note_type === 'CREDIT' ? -Number(note.total) : Number(note.total),
    cost: noteCost,
    profit: note.note_type === 'CREDIT' ? -noteProfit : noteProfit,
    margin: noteMargin,
    customerName: note.customer_name ?? 'CONSUMIDOR FINAL',
    createdBy: note.created_by ?? null,
    synced: true,
    isDeleted: false,
    notesCount: 0,
    noteTypes: null,
    createdAt: toIsoStr(note.created_at),
    noteNumber: note.note_number,
    noteType: note.note_type,
    operationType: note.operation_type,
    parentInvoiceId: Number(note.sale_invoice_id),
  };
}

/**
 * Agrupa notas por sale_invoice_id, separando huérfanas (cuya invoice no
 * está en el set de invoices retornado).
 */
export function groupNotes(
  notes: NoteRow[],
  invoiceIds: Set<number>,
): { byInvoice: Map<number, NoteRow[]>; orphans: NoteRow[] } {
  const byInvoice = new Map<number, NoteRow[]>();
  const orphans: NoteRow[] = [];
  for (const note of notes) {
    const parentId = Number(note.sale_invoice_id);
    if (invoiceIds.has(parentId)) {
      const list = byInvoice.get(parentId) ?? [];
      list.push(note);
      byInvoice.set(parentId, list);
    } else {
      orphans.push(note);
    }
  }
  return { byInvoice, orphans };
}

/**
 * Acumulador Big.js inicializado en cero. Helper de legibilidad.
 */
export function zeroBig(): Big {
  return new Big(0);
}
