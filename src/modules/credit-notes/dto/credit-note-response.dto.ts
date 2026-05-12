import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  type CorrectionSource,
  type CorrectionSourceType,
} from '../entities/correction-source.entity';
import { type CreditNoteLine } from '../entities/credit-note-line.entity';
import { NoteType, OperationType, type CreditNote } from '../entities/credit-note.entity';

/**
 * Shape de respuesta de credit notes. Espeja byte-por-byte la serialización
 * de `placepos/src/main/server/routes/credit-notes.routes.ts` + las consultas
 * `getCreditNoteByInvoiceId`:
 *
 *   - `id` como `number` (cast de bigint).
 *   - Montos como `number` (NumericTransformer ya hizo `Number(...)`).
 *   - Timestamps como ISO 8601.
 *   - Anidación: `lines[]`, `correction_source | null`.
 */

export class CreditNoteLineResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  credit_note_id!: number;

  @ApiPropertyOptional({ example: 12, nullable: true })
  original_line_id!: number | null;

  @ApiProperty({ example: 1 })
  product_id!: number;

  @ApiPropertyOptional({ example: 5, nullable: true })
  packaging_id!: number | null;

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

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export class CorrectionSourceResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  credit_note_id!: number;

  @ApiProperty({ example: 'bank' })
  source_type!: CorrectionSourceType;

  @ApiProperty({ example: 1 })
  source_id!: number;

  @ApiProperty({ example: 'Banco Mercantil' })
  source_name!: string;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 7, nullable: true })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export class CreditNoteResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 42 })
  sale_invoice_id!: number;

  @ApiPropertyOptional({ example: 1, nullable: true })
  customer_id!: number | null;

  @ApiProperty({ example: 'NC-001' })
  note_number!: string;

  @ApiProperty({ enum: NoteType, example: NoteType.CREDIT })
  note_type!: NoteType;

  @ApiProperty({ enum: OperationType, example: OperationType.FULL_VOID })
  operation_type!: OperationType;

  @ApiProperty({ example: 100 })
  subtotal!: number;

  @ApiProperty({ example: 16 })
  tax_total!: number;

  @ApiProperty({ example: 116 })
  total!: number;

  @ApiPropertyOptional({ example: 'Devolución por producto defectuoso.', nullable: true })
  reason!: string | null;

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

  @ApiProperty({ type: [CreditNoteLineResponseDto] })
  lines!: CreditNoteLineResponseDto[];

  @ApiPropertyOptional({ type: CorrectionSourceResponseDto, nullable: true })
  correction_source!: CorrectionSourceResponseDto | null;
}

export function toCreditNoteLineResponseDto(line: CreditNoteLine): CreditNoteLineResponseDto {
  return {
    id: Number(line.id),
    credit_note_id: Number(line.credit_note_id),
    original_line_id: line.original_line_id === null ? null : Number(line.original_line_id),
    product_id: Number(line.product_id),
    packaging_id: line.packaging_id === null ? null : Number(line.packaging_id),
    description: line.description,
    quantity: Number(line.quantity),
    unit_price: Number(line.unit_price),
    unit_cost: Number(line.unit_cost),
    subtotal: Number(line.subtotal),
    iva_percentage: Number(line.iva_percentage),
    iva_amount: Number(line.iva_amount),
    total: Number(line.total),
    created_at: line.created_at.toISOString(),
  };
}

export function toCorrectionSourceResponseDto(cs: CorrectionSource): CorrectionSourceResponseDto {
  return {
    id: Number(cs.id),
    credit_note_id: Number(cs.credit_note_id),
    source_type: cs.source_type,
    source_id: Number(cs.source_id),
    source_name: cs.source_name,
    created_by: cs.created_by,
    created_by_id: cs.created_by_id === null ? null : Number(cs.created_by_id),
    created_at: cs.created_at.toISOString(),
  };
}

export function toCreditNoteResponseDto(
  note: CreditNote,
  lines: CreditNoteLine[],
  correctionSource: CorrectionSource | null,
): CreditNoteResponseDto {
  return {
    id: Number(note.id),
    sale_invoice_id: Number(note.sale_invoice_id),
    customer_id: note.customer_id === null ? null : Number(note.customer_id),
    note_number: note.note_number,
    note_type: note.note_type,
    operation_type: note.operation_type,
    subtotal: Number(note.subtotal),
    tax_total: Number(note.tax_total),
    total: Number(note.total),
    reason: note.reason,
    created_by: note.created_by,
    created_by_id: note.created_by_id === null ? null : Number(note.created_by_id),
    is_deleted: note.is_deleted,
    created_at: note.created_at.toISOString(),
    updated_at: note.updated_at.toISOString(),
    lines: lines.map(toCreditNoteLineResponseDto),
    correction_source: correctionSource ? toCorrectionSourceResponseDto(correctionSource) : null,
  };
}
