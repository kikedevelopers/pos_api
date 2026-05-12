import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { EXPENSE_CATEGORIES } from '../entities/expense.entity';

/**
 * Payload de `PUT /expenses/:id`. SOLO metadata editable.
 *
 * No se permite cambiar `amount`, `source_type`, `source_id` ni
 * `expense_date`: cambiarlos requeriría revertir el movimiento financiero y
 * crear uno nuevo. Si el usuario necesita corregir el monto/fuente, debe
 * anular este gasto (soft-delete) y registrar uno nuevo — paridad con la
 * semántica de `POST /expenses/:id/void` + nuevo `POST /expenses` de
 * PlacePos.
 */
export class UpdateExpenseDto {
  @ApiPropertyOptional({ example: 'Pago de luz mes de Mayo (corregido)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'description no puede estar vacía' })
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    enum: EXPENSE_CATEGORIES,
    example: 'UTILITIES',
    description: 'Categoría libre.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string | null;

  @ApiPropertyOptional({ example: 'Anotación corregida' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
