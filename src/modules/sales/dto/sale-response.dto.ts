import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { SaleCreditStatus, type SaleCredit } from '../entities/sale-credit.entity';
import { type SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { TicketType, type SaleInvoice } from '../entities/sale-invoice.entity';
import {
  SalePaymentMethod,
  type SalePayment,
  type SalePaymentAccountType,
} from '../entities/sale-payment.entity';

/**
 * Shape de respuesta de sales. Espeja byte-por-byte la serialización de
 * `placepos/src/main/server/routes/sales.routes.ts`:
 *
 *   - `id` como `number` (cast de bigint).
 *   - Montos como `number` (NumericTransformer ya hizo `Number(...)`).
 *   - Timestamps como ISO 8601.
 *   - Anidación: `lines[]`, `payments[]`, `credit | null`.
 */

export class SaleInvoiceLineResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  sale_invoice_id!: number;

  @ApiProperty({ example: 1 })
  product_id!: number;

  @ApiPropertyOptional({ example: 5, nullable: true })
  packaging_id!: number | null;

  @ApiPropertyOptional({ example: 3, nullable: true })
  product_price_id!: number | null;

  @ApiProperty({ example: 'Aceite Diana 1L' })
  description!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({ example: 25.5 })
  unit_price!: number;

  @ApiProperty({ example: 15 })
  unit_cost!: number;

  @ApiProperty({ example: 51 })
  subtotal!: number;

  @ApiProperty({ example: 16 })
  iva_percentage!: number;

  @ApiProperty({ example: 8.16 })
  iva_amount!: number;

  @ApiProperty({ example: 59.16 })
  total!: number;

  @ApiProperty({ example: 21 })
  profit!: number;

  @ApiProperty({ example: 35.5004 })
  margin!: number;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export class SalePaymentResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  sale_invoice_id!: number;

  @ApiProperty({ enum: SalePaymentMethod, example: SalePaymentMethod.CASH })
  payment_method!: SalePaymentMethod;

  @ApiProperty({ example: 100 })
  amount!: number;

  @ApiProperty({ example: 0 })
  change_amount!: number;

  @ApiPropertyOptional({ example: 1, nullable: true })
  bank_id!: number | null;

  @ApiPropertyOptional({ example: 'Banco Mercantil', nullable: true })
  bank_name!: string | null;

  @ApiProperty({ example: 'bank' })
  account_type!: SalePaymentAccountType;

  @ApiProperty({ example: 1 })
  account_id!: number;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 7, nullable: true })
  created_by_id!: number | null;

  @ApiPropertyOptional({ example: '6b3b2f3a-2b3d-4b1c-9a4f-1234567890ab', nullable: true })
  uuid!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export class SaleCreditResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  sale_invoice_id!: number;

  @ApiProperty({ example: 1 })
  customer_id!: number;

  @ApiProperty({ example: 1000 })
  total_amount!: number;

  @ApiProperty({ example: 200 })
  paid_amount!: number;

  @ApiProperty({ example: 800 })
  balance!: number;

  @ApiPropertyOptional({ example: '2026-06-12', nullable: true })
  due_date!: string | null;

  @ApiProperty({ enum: SaleCreditStatus, example: SaleCreditStatus.PARTIALLY_PAID })
  status!: SaleCreditStatus;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

export class SaleResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ enum: TicketType, example: TicketType.ORDER })
  ticket_type!: TicketType;

  @ApiProperty({ example: '001' })
  ticket_number!: string;

  @ApiPropertyOptional({ example: '001', nullable: true })
  sale_number!: string | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  customer_id!: number | null;

  @ApiPropertyOptional({ example: 'Juan Pérez', nullable: true })
  customer_name!: string | null;

  @ApiProperty({ example: 100 })
  subtotal!: number;

  @ApiProperty({ example: 16 })
  tax_total!: number;

  @ApiProperty({ example: 116 })
  total!: number;

  @ApiProperty({ example: 60 })
  cost!: number;

  @ApiProperty({ example: 56 })
  profit!: number;

  @ApiProperty({ example: 48.2759 })
  margin!: number;

  @ApiPropertyOptional({ example: 'Venta a crédito', nullable: true })
  notes!: string | null;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 7, nullable: true })
  created_by_id!: number | null;

  @ApiProperty({ example: false })
  is_deleted!: boolean;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;

  @ApiProperty({ type: [SaleInvoiceLineResponseDto] })
  lines!: SaleInvoiceLineResponseDto[];

  @ApiProperty({ type: [SalePaymentResponseDto] })
  payments!: SalePaymentResponseDto[];

  @ApiPropertyOptional({ type: SaleCreditResponseDto, nullable: true })
  credit!: SaleCreditResponseDto | null;
}

export function toSaleInvoiceLineResponseDto(line: SaleInvoiceLine): SaleInvoiceLineResponseDto {
  return {
    id: Number(line.id),
    sale_invoice_id: Number(line.sale_invoice_id),
    product_id: Number(line.product_id),
    packaging_id: line.packaging_id === null ? null : Number(line.packaging_id),
    product_price_id:
      line.product_price_id === null || line.product_price_id === undefined
        ? null
        : Number(line.product_price_id),
    description: line.description,
    quantity: Number(line.quantity),
    unit_price: Number(line.unit_price),
    unit_cost: Number(line.unit_cost),
    subtotal: Number(line.subtotal),
    iva_percentage: Number(line.iva_percentage),
    iva_amount: Number(line.iva_amount),
    total: Number(line.total),
    profit: Number(line.profit),
    margin: Number(line.margin),
    created_at: line.created_at.toISOString(),
  };
}

export function toSalePaymentResponseDto(p: SalePayment): SalePaymentResponseDto {
  return {
    id: Number(p.id),
    sale_invoice_id: Number(p.sale_invoice_id),
    payment_method: p.payment_method,
    amount: Number(p.amount),
    change_amount: Number(p.change_amount),
    bank_id: p.bank_id === null ? null : Number(p.bank_id),
    bank_name: p.bank_name,
    account_type: p.account_type,
    account_id: Number(p.account_id),
    created_by: p.created_by,
    created_by_id: p.created_by_id === null ? null : Number(p.created_by_id),
    uuid: p.uuid,
    created_at: p.created_at.toISOString(),
  };
}

export function toSaleCreditResponseDto(c: SaleCredit): SaleCreditResponseDto {
  return {
    id: Number(c.id),
    sale_invoice_id: Number(c.sale_invoice_id),
    customer_id: Number(c.customer_id),
    total_amount: Number(c.total_amount),
    paid_amount: Number(c.paid_amount),
    balance: Number(c.balance),
    due_date: c.due_date ? toIsoDate(c.due_date) : null,
    status: c.status,
    created_at: c.created_at.toISOString(),
    updated_at: c.updated_at.toISOString(),
  };
}

export function toSaleResponseDto(
  sale: SaleInvoice,
  lines: SaleInvoiceLine[],
  payments: SalePayment[],
  credit: SaleCredit | null,
): SaleResponseDto {
  return {
    id: Number(sale.id),
    ticket_type: sale.ticket_type,
    ticket_number: sale.ticket_number,
    sale_number: sale.sale_number,
    customer_id: sale.customer_id === null ? null : Number(sale.customer_id),
    customer_name: sale.customer_name,
    subtotal: Number(sale.subtotal),
    tax_total: Number(sale.tax_total),
    total: Number(sale.total),
    cost: Number(sale.cost),
    profit: Number(sale.profit),
    margin: Number(sale.margin),
    notes: sale.notes,
    created_by: sale.created_by,
    created_by_id: sale.created_by_id === null ? null : Number(sale.created_by_id),
    is_deleted: sale.is_deleted,
    created_at: sale.created_at.toISOString(),
    updated_at: sale.updated_at.toISOString(),
    lines: lines.map(toSaleInvoiceLineResponseDto),
    payments: payments.map(toSalePaymentResponseDto),
    credit: credit ? toSaleCreditResponseDto(credit) : null,
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
