import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, Min } from 'class-validator';

import { NoteType } from '../entities/credit-note.entity';

/**
 * Query de `GET /credit-notes`. Espejo PlacePos. Filtros opt-in adicionales
 * (sale_invoice_id, customer_id, note_type, date range, limit) que el
 * frontend puede ignorar sin romper paridad.
 */
export class ListCreditNotesQueryDto {
  @ApiPropertyOptional({ example: 50, description: 'Máximo de resultados.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser entero' })
  @Min(1, { message: 'limit debe ser >= 1' })
  limit?: number;

  @ApiPropertyOptional({ example: 42, description: 'Filtrar por venta.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'sale_invoice_id debe ser entero' })
  @Min(1, { message: 'sale_invoice_id debe ser >= 1' })
  sale_invoice_id?: number;

  @ApiPropertyOptional({ example: 1, description: 'Filtrar por cliente.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'customer_id debe ser entero' })
  @Min(1, { message: 'customer_id debe ser >= 1' })
  customer_id?: number;

  @ApiPropertyOptional({ enum: NoteType, description: 'Filtrar por tipo (CREDIT | DEBIT).' })
  @IsOptional()
  @IsEnum(NoteType, { message: 'note_type inválido' })
  note_type?: NoteType;

  @ApiPropertyOptional({ example: '2026-05-01', description: 'Filtrar desde (inclusive).' })
  @IsOptional()
  @IsDateString({}, { message: 'date_from debe ser fecha válida' })
  date_from?: string;

  @ApiPropertyOptional({ example: '2026-05-31', description: 'Filtrar hasta (inclusive).' })
  @IsOptional()
  @IsDateString({}, { message: 'date_to debe ser fecha válida' })
  date_to?: string;

  @ApiPropertyOptional({
    description: 'Si true incluye notas anuladas (is_deleted = true). Default: false.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  show_deleted?: boolean;
}
