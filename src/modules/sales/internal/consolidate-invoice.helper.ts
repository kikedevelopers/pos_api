import Big from 'big.js';
import { LessThanOrEqual, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { CreditNoteLine } from '@/modules/credit-notes/entities/credit-note-line.entity';
import { CreditNote, NoteType } from '@/modules/credit-notes/entities/credit-note.entity';

import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import type { TicketType } from '../entities/sale-invoice.entity';
import { SaleInvoice } from '../entities/sale-invoice.entity';

/**
 * Línea consolidada — espejo PlacePos `ConsolidatedLine`. Representa el
 * estado VIVO de una línea tras aplicar todas las NC/ND.
 *
 * `price_mode` / `price_position` son metadatos del POS (cómo se eligió el
 * precio) que el cloud no persiste. Se emiten con valores neutros (`'fixed'`,
 * `null`) para que `useEditTicket` del cliente pueda hidratar el carrito sin
 * crashear — la UI del POS los usa para repintar el selector de precio.
 */
export interface ConsolidatedLine {
  item_id: number;
  name: string;
  cost: number;
  price: number;
  quantity: number;
  total: number;
  profit: number;
  margin: number;
  price_mode: 'fixed' | 'manual';
  price_position: number | null;
}

/**
 * Snapshot completo de la factura consolidada (cabecera + líneas vivas).
 */
export interface ConsolidatedInvoice {
  id: number;
  ticketType: TicketType;
  ticketNumber: string;
  saleNumber: string | null;
  total: number;
  cost: number;
  profit: number;
  margin: number;
  customerName: string;
  customerId: number | null;
  lines: ConsolidatedLine[];
}

/**
 * Snapshot mínimo de una NC/ND para consolidar líneas.
 */
interface NoteSnapshot {
  id: number;
  note_type: NoteType;
  lines: Array<{
    item_id: number;
    name: string;
    cost: number;
    price: number;
    quantity: number;
    total: number;
  }>;
}

/**
 * Totales agregados (consolidados) de una venta — espejo PlacePos
 * `computeAdjustments`. Se usa también desde reports.
 */
export interface AdjustmentTotals {
  total: number;
  cost: number;
  profit: number;
  margin: number;
}

/**
 * Aplica una línea de NC (CREDIT) sobre el mapa vivo: resta cantidad o
 * elimina la línea si queda en 0.
 */
function applyCreditAdjustment(
  linesMap: Map<number, ConsolidatedLine>,
  noteLine: NoteSnapshot['lines'][number],
): void {
  const existing = linesMap.get(noteLine.item_id);
  if (!existing) {
    return;
  }
  const newQty = new Big(existing.quantity).minus(noteLine.quantity).toNumber();
  if (newQty <= 0) {
    linesMap.delete(noteLine.item_id);
    return;
  }
  existing.quantity = newQty;
  existing.total = preciseNumber(new Big(existing.price).times(newQty), 2);
  existing.profit = preciseNumber(new Big(existing.price).minus(existing.cost).times(newQty), 2);
}

/**
 * Aplica una línea de ND (DEBIT): suma cantidad si existe o crea una nueva
 * entrada.
 */
function applyDebitAdjustment(
  linesMap: Map<number, ConsolidatedLine>,
  noteLine: NoteSnapshot['lines'][number],
): void {
  const existing = linesMap.get(noteLine.item_id);
  if (existing) {
    const newQty = new Big(existing.quantity).plus(noteLine.quantity).toNumber();
    existing.quantity = newQty;
    existing.total = preciseNumber(new Big(existing.price).times(newQty), 2);
    existing.profit = preciseNumber(new Big(existing.price).minus(existing.cost).times(newQty), 2);
    return;
  }
  const profit = preciseNumber(
    new Big(noteLine.price).minus(noteLine.cost).times(noteLine.quantity),
    2,
  );
  const margin =
    noteLine.price > 0
      ? preciseNumber(
          new Big(noteLine.price).minus(noteLine.cost).div(noteLine.price).times(100),
          4,
        )
      : 0;
  linesMap.set(noteLine.item_id, {
    item_id: noteLine.item_id,
    name: noteLine.name,
    cost: noteLine.cost,
    price: noteLine.price,
    quantity: noteLine.quantity,
    total: noteLine.total,
    profit,
    margin,
    price_mode: 'fixed',
    price_position: null,
  });
}

/**
 * Construye las líneas vivas aplicando NC/ND en orden cronológico ASC.
 * Espejo `buildConsolidatedLines` de PlacePos.
 */
function buildConsolidatedLines(
  originalLines: ConsolidatedLine[],
  notes: NoteSnapshot[],
): ConsolidatedLine[] {
  const linesMap = new Map<number, ConsolidatedLine>();
  for (const line of originalLines) {
    linesMap.set(line.item_id, { ...line });
  }
  for (const note of notes) {
    for (const nl of note.lines) {
      if (note.note_type === NoteType.CREDIT) {
        applyCreditAdjustment(linesMap, nl);
      } else if (note.note_type === NoteType.DEBIT) {
        applyDebitAdjustment(linesMap, nl);
      }
    }
  }
  return Array.from(linesMap.values());
}

function aggregateLines(lines: ConsolidatedLine[]): AdjustmentTotals {
  const total = lines.reduce((s, l) => toBig(s).plus(l.total).toNumber(), 0);
  const cost = lines.reduce((s, l) => toBig(s).plus(toBig(l.cost).times(l.quantity)).toNumber(), 0);
  const profit = lines.reduce((s, l) => toBig(s).plus(l.profit).toNumber(), 0);
  const margin = total > 0 ? preciseNumber(toBig(profit).div(total).times(100), 4) : 0;
  return {
    total: preciseNumber(total, 2),
    cost: preciseNumber(cost, 2),
    profit: preciseNumber(profit, 2),
    margin,
  };
}

function mapInvoiceLine(l: SaleInvoiceLine): ConsolidatedLine {
  return {
    item_id: Number(l.product_id),
    name: l.description,
    cost: Number(l.unit_cost),
    price: Number(l.unit_price),
    quantity: Number(l.quantity),
    total: Number(l.total),
    profit: Number(l.profit),
    margin: Number(l.margin),
    // Cloud no persiste estos metadatos del POS. Valores neutros que
    // permiten al renderer hidratar el cart sin lógica condicional extra.
    price_mode: 'fixed',
    price_position: null,
  };
}

function mapNoteSnapshot(cn: CreditNote, lines: CreditNoteLine[]): NoteSnapshot {
  return {
    id: Number(cn.id),
    note_type: cn.note_type,
    lines: lines.map((l) => ({
      item_id: Number(l.product_id),
      name: l.description,
      cost: Number(l.unit_cost),
      price: Number(l.unit_price),
      quantity: Number(l.quantity),
      total: Number(l.total),
    })),
  };
}

/**
 * Calcula los totales consolidados (post NC/ND) a partir de una venta y sus
 * notas pre-cargadas. Espejo `computeAdjustments` de PlacePos.
 *
 *   consolidatedTotal = inv.total - Σ CN.total + Σ DN.total
 *   consolidatedCost  = inv.cost  - Σ(cn.line.cost*qty) + Σ(dn.line.cost*qty)
 *   profit = total - cost; margin = profit/total * 100 (0 si total <= 0).
 */
export function computeAdjustments(invoice: SaleInvoice, notes: CreditNote[]): AdjustmentTotals {
  const credit = notes.filter((n) => n.note_type === NoteType.CREDIT);
  const debit = notes.filter((n) => n.note_type === NoteType.DEBIT);

  const creditTotal = credit.reduce((s, n) => s.plus(toBig(n.total)), toBig(0));
  const debitTotal = debit.reduce((s, n) => s.plus(toBig(n.total)), toBig(0));
  const consolidatedTotal = toBig(invoice.total).minus(creditTotal).plus(debitTotal);

  const creditCostAdj = credit.reduce((s, cn) => {
    const lineSum = (cn.lines ?? []).reduce(
      (ls, l) => ls.plus(toBig(l.unit_cost).times(l.quantity)),
      toBig(0),
    );
    return s.plus(lineSum);
  }, toBig(0));
  const debitCostAdj = debit.reduce((s, cn) => {
    const lineSum = (cn.lines ?? []).reduce(
      (ls, l) => ls.plus(toBig(l.unit_cost).times(l.quantity)),
      toBig(0),
    );
    return s.plus(lineSum);
  }, toBig(0));

  const consolidatedCost = toBig(invoice.cost).minus(creditCostAdj).plus(debitCostAdj);
  const consolidatedProfit = consolidatedTotal.minus(consolidatedCost);
  const consolidatedMargin = consolidatedTotal.gt(0)
    ? preciseNumber(consolidatedProfit.div(consolidatedTotal).times(100), 4)
    : 0;

  return {
    total: preciseNumber(consolidatedTotal, 2),
    cost: preciseNumber(consolidatedCost, 2),
    profit: preciseNumber(consolidatedProfit, 2),
    margin: consolidatedMargin,
  };
}

/**
 * Construye el agregado consolidado completo (cabecera + líneas vivas) de
 * una venta. Multi-tenant: filtra por company_id en TODOS los lookups.
 *
 * Retorna `null` si la venta no existe en la company (anti-IDOR — el caller
 * decide si lanza 404).
 */
export async function getConsolidatedInvoice(
  manager: EntityManager,
  companyId: number,
  invoiceId: number,
): Promise<ConsolidatedInvoice | null> {
  const invoice = await manager.findOne(SaleInvoice, {
    where: { id: String(invoiceId), company_id: String(companyId) },
  });
  if (!invoice) {
    return null;
  }

  const invoiceLines = await manager.find(SaleInvoiceLine, {
    where: { sale_invoice_id: invoice.id, company_id: String(companyId) },
    order: { id: 'ASC' },
  });

  const notes = await manager.find(CreditNote, {
    where: {
      sale_invoice_id: invoice.id,
      company_id: String(companyId),
      is_deleted: false,
    },
    order: { created_at: 'ASC' },
  });

  // Lines por nota (batch).
  const noteIds = notes.map((n) => n.id);
  const allNoteLines =
    noteIds.length === 0
      ? []
      : await manager
          .createQueryBuilder(CreditNoteLine, 'cnl')
          .where('cnl.company_id = :companyId', { companyId: String(companyId) })
          .andWhere('cnl.credit_note_id IN (:...noteIds)', { noteIds })
          .orderBy('cnl.id', 'ASC')
          .getMany();
  const linesByNote = new Map<string, CreditNoteLine[]>();
  for (const l of allNoteLines) {
    const k = String(l.credit_note_id);
    const arr = linesByNote.get(k) ?? [];
    arr.push(l);
    linesByNote.set(k, arr);
  }

  const noteSnapshots = notes.map((n) => mapNoteSnapshot(n, linesByNote.get(String(n.id)) ?? []));
  const originalLines = invoiceLines.map(mapInvoiceLine);
  const consolidatedLines = buildConsolidatedLines(originalLines, noteSnapshots);
  const totals = aggregateLines(consolidatedLines);

  return {
    id: Number(invoice.id),
    ticketType: invoice.ticket_type,
    ticketNumber: invoice.ticket_number,
    saleNumber: invoice.sale_number ?? null,
    total: totals.total,
    cost: totals.cost,
    profit: totals.profit,
    margin: totals.margin,
    customerName: invoice.customer_name ?? 'CONSUMIDOR FINAL',
    customerId: invoice.customer_id ? Number(invoice.customer_id) : null,
    lines: consolidatedLines,
  };
}

/**
 * Reconstruye el estado del ticket hasta una NC específica (inclusive). Útil
 * para impresión histórica — el cliente puede pedir "muéstrame el consolidado
 * tal como lo vio cuando se emitió la nota X".
 */
export async function getConsolidatedInvoiceUpTo(
  manager: EntityManager,
  companyId: number,
  invoiceId: number,
  upToNoteId: number,
): Promise<ConsolidatedInvoice | null> {
  const invoice = await manager.findOne(SaleInvoice, {
    where: { id: String(invoiceId), company_id: String(companyId) },
  });
  if (!invoice) {
    return null;
  }

  const invoiceLines = await manager.find(SaleInvoiceLine, {
    where: { sale_invoice_id: invoice.id, company_id: String(companyId) },
    order: { id: 'ASC' },
  });

  const notes = await manager.find(CreditNote, {
    where: {
      sale_invoice_id: invoice.id,
      company_id: String(companyId),
      is_deleted: false,
      id: LessThanOrEqual(String(upToNoteId)),
    },
    order: { created_at: 'ASC' },
  });

  const noteIds = notes.map((n) => n.id);
  const allNoteLines =
    noteIds.length === 0
      ? []
      : await manager
          .createQueryBuilder(CreditNoteLine, 'cnl')
          .where('cnl.company_id = :companyId', { companyId: String(companyId) })
          .andWhere('cnl.credit_note_id IN (:...noteIds)', { noteIds })
          .orderBy('cnl.id', 'ASC')
          .getMany();
  const linesByNote = new Map<string, CreditNoteLine[]>();
  for (const l of allNoteLines) {
    const k = String(l.credit_note_id);
    const arr = linesByNote.get(k) ?? [];
    arr.push(l);
    linesByNote.set(k, arr);
  }

  const noteSnapshots = notes.map((n) => mapNoteSnapshot(n, linesByNote.get(String(n.id)) ?? []));
  const originalLines = invoiceLines.map(mapInvoiceLine);
  const consolidatedLines = buildConsolidatedLines(originalLines, noteSnapshots);
  const totals = aggregateLines(consolidatedLines);

  return {
    id: Number(invoice.id),
    ticketType: invoice.ticket_type,
    ticketNumber: invoice.ticket_number,
    saleNumber: invoice.sale_number ?? null,
    total: totals.total,
    cost: totals.cost,
    profit: totals.profit,
    margin: totals.margin,
    customerName: invoice.customer_name ?? 'CONSUMIDOR FINAL',
    customerId: invoice.customer_id ? Number(invoice.customer_id) : null,
    lines: consolidatedLines,
  };
}
