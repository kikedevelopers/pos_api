import { ApiProperty } from '@nestjs/swagger';

import {
  CreditNote,
  NoteType,
  OperationType,
} from '@/modules/credit-notes/entities/credit-note.entity';

/**
 * Espejo PlacePos `CreditNoteDetail` — shape devuelto por
 * GET /sales/:id/credit-note. NO incluye líneas ni consolidated_invoice.
 */
export class SaleCreditNoteResponseDto {
  @ApiProperty({ type: 'integer' })
  id!: number;

  @ApiProperty()
  noteNumber!: string;

  @ApiProperty({ enum: NoteType })
  noteType!: NoteType;

  @ApiProperty({ enum: OperationType })
  operationType!: OperationType;

  @ApiProperty({ type: 'integer' })
  originalInvoiceId!: number;

  @ApiProperty({ type: 'number' })
  total!: number;

  @ApiProperty({ type: 'string', nullable: true })
  reason!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt!: string;
}

export function toSaleCreditNoteResponseDto(cn: CreditNote): SaleCreditNoteResponseDto {
  return {
    id: Number(cn.id),
    noteNumber: cn.note_number,
    noteType: cn.note_type,
    operationType: cn.operation_type,
    originalInvoiceId: Number(cn.sale_invoice_id),
    total: Number(cn.total),
    reason: cn.reason,
    createdAt: cn.created_at.toISOString(),
  };
}
