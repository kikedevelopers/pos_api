import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { PurchaseCreditStatus, type PurchaseCredit } from '../entities/purchase-credit.entity';
import { type PurchaseLine } from '../entities/purchase-line.entity';
import {
  PurchasePaymentMethod,
  type PurchasePayment,
  type PurchasePaymentSourceType,
} from '../entities/purchase-payment.entity';
import { PurchaseStatus, type Purchase } from '../entities/purchase.entity';

/**
 * Shape de respuesta de purchases. Espeja byte-por-byte la serialización de
 * `placepos/src/main/server/routes/purchases.routes.ts`:
 *
 *   - `id` como number (cast de bigint).
 *   - Montos como `number` (transformer ya hizo `Number(...)`).
 *   - `created_at` / `received_at` / `updated_at` como ISO 8601.
 *   - Anidación: `lines[]`, `credit | null`, `payments[]`.
 */

export class PurchaseLineResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  purchase_id!: number;

  @ApiProperty({ example: 1 })
  product_id!: number;

  @ApiProperty({ example: 1 })
  supplier_id!: number;

  @ApiProperty({ example: 'Aceite Diana 1L' })
  name!: string;

  @ApiPropertyOptional({ example: 5, nullable: true })
  packaging_id!: number | null;

  @ApiPropertyOptional({ example: 'Caja x 24', nullable: true })
  packaging_name!: string | null;

  @ApiPropertyOptional({ example: 24, nullable: true })
  packaging_value!: number | null;

  @ApiProperty({ example: 10 })
  packaging_qty!: number;

  @ApiProperty({ example: 240 })
  unit_qty!: number;

  @ApiProperty({ example: 1.5 })
  unit_price!: number;

  @ApiProperty({ example: 36 })
  packaging_price!: number;

  @ApiProperty({ example: 16 })
  iva_rate!: number;

  @ApiProperty({ example: 360 })
  subtotal!: number;

  @ApiProperty({ example: 57.6 })
  iva_amount!: number;

  @ApiProperty({ example: 417.6 })
  total!: number;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export class PurchasePaymentResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  purchase_id!: number;

  @ApiProperty({ example: 'ABO-001' })
  payment_number!: string;

  @ApiProperty({ enum: PurchasePaymentMethod, example: PurchasePaymentMethod.TRANSFER })
  payment_method!: PurchasePaymentMethod;

  @ApiProperty({ example: 150.5 })
  amount!: number;

  @ApiPropertyOptional({ example: 1, nullable: true })
  bank_id!: number | null;

  @ApiPropertyOptional({ example: 'Banco Mercantil', nullable: true })
  bank_name!: string | null;

  @ApiPropertyOptional({ example: 'bank', nullable: true })
  source_type!: PurchasePaymentSourceType | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  source_id!: number | null;

  @ApiPropertyOptional({ example: 'Abono parcial', nullable: true })
  notes!: string | null;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 7, nullable: true })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export class PurchaseCreditResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  purchase_id!: number;

  @ApiProperty({ example: 1000 })
  total_amount!: number;

  @ApiProperty({ example: 150.5 })
  paid_amount!: number;

  @ApiProperty({ example: 849.5 })
  balance!: number;

  @ApiProperty({ enum: PurchaseCreditStatus, example: PurchaseCreditStatus.PARTIALLY_PAID })
  status!: PurchaseCreditStatus;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

export class PurchaseResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'PUR-001' })
  purchase_number!: string;

  @ApiProperty({ example: 1 })
  supplier_id!: number;

  @ApiProperty({ example: 'Distribuidora Andina C.A.' })
  supplier_name!: string;

  @ApiProperty({ example: 360 })
  subtotal!: number;

  @ApiProperty({ example: 57.6 })
  iva_total!: number;

  @ApiProperty({ example: 417.6 })
  total!: number;

  @ApiPropertyOptional({ example: 'Pedido semanal', nullable: true })
  notes!: string | null;

  @ApiProperty({ enum: PurchaseStatus, example: PurchaseStatus.PENDING })
  status!: PurchaseStatus;

  @ApiPropertyOptional({ example: 7, nullable: true })
  carrier_id!: number | null;

  @ApiPropertyOptional({ example: 'Transportes Express', nullable: true })
  carrier_name!: string | null;

  @ApiProperty({ example: 25.5, description: 'Costo del flete. 0 si no aplica.' })
  transport_cost!: number;

  @ApiPropertyOptional({
    example: 1200.5,
    nullable: true,
    description: 'Peso total transportado en kg. NULL si no se reportó.',
  })
  total_kilos!: number | null;

  @ApiPropertyOptional({
    example: '2026-05-12',
    nullable: true,
    description: 'Fecha de la factura física del proveedor. NULL si entró como remisión.',
  })
  invoice_date!: string | null;

  @ApiPropertyOptional({
    example: 'F-2025-00123',
    nullable: true,
    description: 'Número de factura del proveedor. NULL si entró como remisión.',
  })
  invoice_number!: string | null;

  @ApiPropertyOptional({ example: 'Juan Pérez', nullable: true })
  received_by!: string | null;

  @ApiPropertyOptional({ example: '2026-05-12T14:30:00.000Z', nullable: true })
  received_at!: string | null;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiProperty({ example: false })
  is_deleted!: boolean;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;

  @ApiProperty({ type: [PurchaseLineResponseDto] })
  lines!: PurchaseLineResponseDto[];

  @ApiPropertyOptional({ type: PurchaseCreditResponseDto, nullable: true })
  credit!: PurchaseCreditResponseDto | null;

  @ApiProperty({ type: [PurchasePaymentResponseDto] })
  payments!: PurchasePaymentResponseDto[];
}

export function toPurchaseLineResponseDto(line: PurchaseLine): PurchaseLineResponseDto {
  return {
    id: Number(line.id),
    purchase_id: Number(line.purchase_id),
    product_id: Number(line.product_id),
    supplier_id: Number(line.supplier_id),
    name: line.name,
    packaging_id: line.packaging_id === null ? null : Number(line.packaging_id),
    packaging_name: line.packaging_name,
    packaging_value:
      line.packaging_value === null || line.packaging_value === undefined
        ? null
        : Number(line.packaging_value),
    packaging_qty: Number(line.packaging_qty),
    unit_qty: Number(line.unit_qty),
    unit_price: Number(line.unit_price),
    packaging_price: Number(line.packaging_price),
    iva_rate: Number(line.iva_rate),
    subtotal: Number(line.subtotal),
    iva_amount: Number(line.iva_amount),
    total: Number(line.total),
    created_at: line.created_at.toISOString(),
  };
}

export function toPurchasePaymentResponseDto(p: PurchasePayment): PurchasePaymentResponseDto {
  return {
    id: Number(p.id),
    purchase_id: Number(p.purchase_id),
    payment_number: p.payment_number,
    payment_method: p.payment_method,
    amount: Number(p.amount),
    bank_id: p.bank_id === null ? null : Number(p.bank_id),
    bank_name: p.bank_name,
    source_type: p.source_type,
    source_id: p.source_id === null ? null : Number(p.source_id),
    notes: p.notes,
    created_by: p.created_by,
    created_by_id: p.created_by_id === null ? null : Number(p.created_by_id),
    created_at: p.created_at.toISOString(),
  };
}

export function toPurchaseCreditResponseDto(c: PurchaseCredit): PurchaseCreditResponseDto {
  return {
    id: Number(c.id),
    purchase_id: Number(c.purchase_id),
    total_amount: Number(c.total_amount),
    paid_amount: Number(c.paid_amount),
    balance: Number(c.balance),
    status: c.status,
    created_at: c.created_at.toISOString(),
    updated_at: c.updated_at.toISOString(),
  };
}

export function toPurchaseResponseDto(
  purchase: Purchase,
  lines: PurchaseLine[],
  credit: PurchaseCredit | null,
  payments: PurchasePayment[],
): PurchaseResponseDto {
  return {
    id: Number(purchase.id),
    purchase_number: purchase.purchase_number,
    supplier_id: Number(purchase.supplier_id),
    supplier_name: purchase.supplier_name,
    subtotal: Number(purchase.subtotal),
    iva_total: Number(purchase.iva_total),
    total: Number(purchase.total),
    notes: purchase.notes,
    status: purchase.status,
    carrier_id: purchase.carrier_id === null ? null : Number(purchase.carrier_id),
    carrier_name: purchase.carrier_name,
    transport_cost: Number(purchase.transport_cost ?? 0),
    total_kilos:
      purchase.total_kilos === null || purchase.total_kilos === undefined
        ? null
        : Number(purchase.total_kilos),
    invoice_date: purchase.invoice_date
      ? purchase.invoice_date instanceof Date
        ? purchase.invoice_date.toISOString()
        : String(purchase.invoice_date)
      : null,
    invoice_number: purchase.invoice_number,
    received_by: purchase.received_by,
    received_at: purchase.received_at ? purchase.received_at.toISOString() : null,
    created_by: purchase.created_by,
    is_deleted: purchase.is_deleted,
    created_at: purchase.created_at.toISOString(),
    updated_at: purchase.updated_at.toISOString(),
    lines: lines.map(toPurchaseLineResponseDto),
    credit: credit ? toPurchaseCreditResponseDto(credit) : null,
    payments: payments.map(toPurchasePaymentResponseDto),
  };
}
