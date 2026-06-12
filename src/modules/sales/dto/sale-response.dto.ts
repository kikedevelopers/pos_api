import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  CreditNote,
  NoteType,
  OperationType,
} from '@/modules/credit-notes/entities/credit-note.entity';
import { CreditNoteLine } from '@/modules/credit-notes/entities/credit-note-line.entity';

import { SaleCreditStatus, type SaleCredit } from '../entities/sale-credit.entity';
import { type SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { TicketType, type SaleInvoice } from '../entities/sale-invoice.entity';
import { SalePaymentMethod, type SalePayment } from '../entities/sale-payment.entity';

/**
 * Shape de respuesta de `GET /sales/:id` — espejo byte-por-byte del
 * `TicketDetail` que el cliente PlacePos consume desde
 * `getTicketById` (saleOperations.ts). Mantiene EL MISMO CONTRATO que el modo
 * servidor/cliente local de PlacePos.
 *
 * Reglas duras:
 *   - camelCase (`ticketNumber`, `customerName`, `createdAt`, etc.) — el
 *     renderer hace `ticket.customerName.toLowerCase()` y similares.
 *   - Lines: `id`, `name`, `quantity`, `price`, `total` (NO description /
 *     unit_price / sale_invoice_id).
 *   - Payments: `paymentMethod`, `amountDue`, `amountPaid`, `changeAmount`,
 *     `createdAt`.
 *   - Credit: `totalAmount`, `paidAmount`, `balance`, `dueDate`, `status`,
 *     `createdAt`. Status mapeado: `PARTIALLY_PAID` (cloud) → `PARTIAL` (PlacePos).
 *   - `customerName`: `customer_name || 'CONSUMIDOR FINAL'`.
 *   - `synced`: siempre `true` (cloud no tiene cola offline).
 *   - `documents[]`: lista cronológica { ORIGINAL, NC, ND } con líneas
 *     y `correctionSource` opcional.
 *   - `voidCreditNote`: la NC/ND más reciente (last en `documents` post
 *     ORIGINAL), `null` si la venta no tiene notas.
 *
 * El interceptor global `ResponseWrapperInterceptor` envuelve este DTO en
 * `{ success: true, payload: <este shape> }` — el cliente lo desempaqueta
 * vía `lanProxy` y lo pasa tal cual al renderer.
 */

export class TicketLineResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Aceite Diana 1L' })
  name!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({ example: 25.5 })
  price!: number;

  @ApiProperty({ example: 51 })
  total!: number;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: 'Sin cebolla, bien cocido.',
    description: 'Nota por línea de venta. null si la línea no tiene nota.',
  })
  note!: string | null;
}

export class TicketPaymentResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ enum: ['CASH', 'TRANSFER', 'CREDIT'], example: 'CASH' })
  paymentMethod!: 'CASH' | 'TRANSFER' | 'CREDIT';

  @ApiProperty({ example: 100 })
  amountDue!: number;

  @ApiProperty({ example: 100 })
  amountPaid!: number;

  @ApiProperty({ example: 0 })
  changeAmount!: number;

  @ApiProperty({ example: 'Bancolombia', nullable: true })
  bankName!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  createdAt!: string;
}

export class TicketCreditResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1000 })
  totalAmount!: number;

  @ApiProperty({ example: 200 })
  paidAmount!: number;

  @ApiProperty({ example: 800 })
  balance!: number;

  @ApiProperty({ example: '2026-06-12' })
  dueDate!: string;

  @ApiProperty({ enum: ['PENDING', 'PARTIAL', 'PAID'], example: 'PARTIAL' })
  status!: 'PENDING' | 'PARTIAL' | 'PAID';

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  createdAt!: string;
}

export class VoidCreditNoteSummaryDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'NC-001' })
  noteNumber!: string;

  @ApiProperty({ enum: NoteType })
  noteType!: NoteType;

  @ApiProperty({ enum: OperationType })
  operationType!: OperationType;

  @ApiProperty({ example: 100 })
  total!: number;

  @ApiPropertyOptional({ type: 'string', nullable: true })
  reason!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  createdAt!: string;
}

export class InvoiceDocumentCorrectionSourceDto {
  @ApiProperty({ example: 'cash_register' })
  type!: string;

  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Caja Registradora #1' })
  name!: string;
}

export class InvoiceDocumentResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ enum: ['ORIGINAL', 'CREDIT_NOTE', 'DEBIT_NOTE'] })
  documentType!: 'ORIGINAL' | 'CREDIT_NOTE' | 'DEBIT_NOTE';

  @ApiProperty({ enum: NoteType, nullable: true })
  noteType!: NoteType | null;

  @ApiProperty({ enum: OperationType, nullable: true })
  operationType!: OperationType | null;

  @ApiProperty({ example: 'V-001' })
  documentNumber!: string;

  @ApiProperty({ example: 100 })
  total!: number;

  @ApiPropertyOptional({ type: 'string', nullable: true })
  reason!: string | null;

  @ApiPropertyOptional({ type: 'string', nullable: true })
  createdBy!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  createdAt!: string;

  @ApiPropertyOptional({ type: InvoiceDocumentCorrectionSourceDto, nullable: true })
  correctionSource!: InvoiceDocumentCorrectionSourceDto | null;

  @ApiProperty({ type: [TicketLineResponseDto] })
  lines!: TicketLineResponseDto[];
}

export class SaleResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ enum: TicketType })
  ticketType!: TicketType;

  @ApiProperty({ example: 'V-001' })
  ticketNumber!: string;

  @ApiPropertyOptional({ example: 'V-001', nullable: true })
  saleNumber!: string | null;

  @ApiProperty({ example: 116 })
  total!: number;

  @ApiProperty({ example: 60 })
  cost!: number;

  @ApiProperty({ example: 56 })
  profit!: number;

  @ApiProperty({ example: 48.2759 })
  margin!: number;

  @ApiProperty({
    example: 'Juan Pérez',
    description: "Snapshot del nombre. Mostrador → 'CONSUMIDOR FINAL'.",
  })
  customerName!: string;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: 'Pago en efectivo + transferencia.',
    description: 'Nota a nivel ticket (sale_invoices.notes). null si no tiene.',
  })
  notes!: string | null;

  @ApiPropertyOptional({ type: 'string', nullable: true })
  createdBy!: string | null;

  @ApiProperty({ example: true, description: 'Siempre true en cloud (no hay cola offline).' })
  synced!: true;

  @ApiProperty({ example: false })
  isDeleted!: boolean;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updatedAt!: string;

  @ApiProperty({ type: [TicketLineResponseDto] })
  lines!: TicketLineResponseDto[];

  @ApiProperty({ type: [TicketPaymentResponseDto] })
  payments!: TicketPaymentResponseDto[];

  @ApiPropertyOptional({ type: TicketCreditResponseDto, nullable: true })
  credit!: TicketCreditResponseDto | null;

  @ApiPropertyOptional({ type: VoidCreditNoteSummaryDto, nullable: true })
  voidCreditNote!: VoidCreditNoteSummaryDto | null;

  @ApiProperty({ type: [InvoiceDocumentResponseDto] })
  documents!: InvoiceDocumentResponseDto[];
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapCreditStatus(status: SaleCreditStatus): 'PENDING' | 'PARTIAL' | 'PAID' {
  // Paridad PlacePos: el cliente usa `PARTIAL` (no `PARTIALLY_PAID` del
  // enum cloud). El enum interno se mantiene para la BD; aquí se aplana al
  // nombre legacy que el renderer consume.
  switch (status) {
    case SaleCreditStatus.PENDING:
      return 'PENDING';
    case SaleCreditStatus.PARTIALLY_PAID:
      return 'PARTIAL';
    case SaleCreditStatus.PAID:
      return 'PAID';
  }
}

function toTicketLine(line: SaleInvoiceLine): TicketLineResponseDto {
  return {
    id: Number(line.id),
    name: line.description,
    quantity: Number(line.quantity),
    price: Number(line.unit_price),
    total: Number(line.total),
    note: line.note ?? null,
  };
}

function toCreditNoteLine(line: CreditNoteLine): TicketLineResponseDto {
  // Las NC/ND se serializan con el mismo shape que las líneas de venta para
  // que el TicketReceipt pueda renderizar `documents[i].lines` sin lógica
  // adicional. `id` toma el `product_id` (paridad PlacePos: cuando una NC
  // hereda líneas de la V original, el item_id es estable, mientras que el
  // id de la línea de la NC cambia entre emisiones).
  return {
    id: Number(line.product_id),
    name: line.description,
    quantity: Number(line.quantity),
    price: Number(line.unit_price),
    total: Number(line.total),
    // Las líneas de NC/ND no llevan nota por línea (la nota vive solo en la
    // venta original). Se expone como null para uniformar el shape.
    note: null,
  };
}

function toTicketPayment(p: SalePayment): TicketPaymentResponseDto {
  // Mapeo cloud → legacy PlacePos:
  //   amount_due  ≡ amount (lo que se aplicó al saldo).
  //   amount_paid ≡ amount + change_amount (lo entregado por el cliente).
  // En transferencias change_amount = 0 → amountPaid = amountDue.
  const amount = Number(p.amount);
  const change = Number(p.change_amount);
  const paymentMethod: 'CASH' | 'TRANSFER' | 'CREDIT' =
    p.payment_method === SalePaymentMethod.CASH ? 'CASH' : 'TRANSFER';
  return {
    id: Number(p.id),
    paymentMethod,
    amountDue: amount,
    amountPaid: amount + change,
    changeAmount: change,
    bankName: p.bank_name ?? null,
    createdAt: p.created_at.toISOString(),
  };
}

function toTicketCredit(c: SaleCredit): TicketCreditResponseDto {
  return {
    id: Number(c.id),
    totalAmount: Number(c.total_amount),
    paidAmount: Number(c.paid_amount),
    balance: Number(c.balance),
    dueDate: c.due_date ? toIsoDate(c.due_date) : '',
    status: mapCreditStatus(c.status),
    createdAt: c.created_at.toISOString(),
  };
}

function toVoidCreditNote(cn: CreditNote): VoidCreditNoteSummaryDto {
  return {
    id: Number(cn.id),
    noteNumber: cn.note_number,
    noteType: cn.note_type,
    operationType: cn.operation_type,
    total: Number(cn.total),
    reason: cn.reason,
    createdAt: cn.created_at.toISOString(),
  };
}

function buildInvoiceDocuments(
  sale: SaleInvoice,
  invoiceLines: SaleInvoiceLine[],
  sortedNotes: CreditNote[],
): InvoiceDocumentResponseDto[] {
  const documents: InvoiceDocumentResponseDto[] = [];

  documents.push({
    id: Number(sale.id),
    documentType: 'ORIGINAL',
    noteType: null,
    operationType: null,
    documentNumber: sale.sale_number ?? sale.ticket_number,
    total: Number(sale.total),
    reason: null,
    createdBy: sale.created_by,
    createdAt: sale.created_at.toISOString(),
    correctionSource: null,
    lines: invoiceLines.map(toTicketLine),
  });

  for (const note of sortedNotes) {
    documents.push({
      id: Number(note.id),
      documentType: note.note_type === NoteType.CREDIT ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
      noteType: note.note_type,
      operationType: note.operation_type,
      documentNumber: note.note_number,
      total: Number(note.total),
      reason: note.reason,
      createdBy: note.created_by,
      createdAt: note.created_at.toISOString(),
      correctionSource: note.correction_source
        ? {
            type: note.correction_source.source_type,
            id: Number(note.correction_source.source_id),
            name: note.correction_source.source_name,
          }
        : null,
      lines: (note.lines ?? []).map(toCreditNoteLine),
    });
  }

  return documents;
}

/**
 * Construye la respuesta completa del detalle de venta. El caller (la action)
 * es responsable de proveer las NC/ND ya pre-cargadas con `lines` y
 * `correction_source` para evitar N+1 — el mapper no consulta BD.
 */
export function toSaleResponseDto(
  sale: SaleInvoice,
  lines: SaleInvoiceLine[],
  payments: SalePayment[],
  credit: SaleCredit | null,
  creditNotes: CreditNote[] = [],
): SaleResponseDto {
  const sortedNotes = [...creditNotes].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime(),
  );
  const lastNote = sortedNotes.length > 0 ? sortedNotes[sortedNotes.length - 1] : null;

  return {
    id: Number(sale.id),
    ticketType: sale.ticket_type,
    ticketNumber: sale.ticket_number,
    saleNumber: sale.sale_number,
    total: Number(sale.total),
    cost: Number(sale.cost),
    profit: Number(sale.profit),
    margin: Number(sale.margin),
    customerName: sale.customer_name || 'CONSUMIDOR FINAL',
    notes: sale.notes ?? null,
    createdBy: sale.created_by,
    synced: true,
    isDeleted: sale.is_deleted,
    createdAt: sale.created_at.toISOString(),
    updatedAt: sale.updated_at.toISOString(),
    lines: lines.map(toTicketLine),
    payments: payments.map(toTicketPayment),
    credit: credit ? toTicketCredit(credit) : null,
    voidCreditNote: lastNote ? toVoidCreditNote(lastNote) : null,
    documents: buildInvoiceDocuments(sale, lines, sortedNotes),
  };
}

/**
 * Convierte un `Date` (o string) de columna `date` en formato `YYYY-MM-DD`.
 * pg devuelve `date` como string ya formateado, pero TypeORM puede mapearlo
 * como Date. Esta función cubre ambos casos.
 */
function toIsoDate(value: Date | string): string {
  if (value instanceof Date) {
    const yyyy = value.getUTCFullYear();
    const mm = String(value.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(value.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return value;
}
