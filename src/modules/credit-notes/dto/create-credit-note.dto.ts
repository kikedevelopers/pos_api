import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { NoteType, OperationType } from '../entities/credit-note.entity';

/**
 * Una línea del payload de `POST /credit-notes`. Espejo PlacePos
 * `CreditNoteLinePayload`.
 *
 * Aplica a:
 *   - `PARTIAL_VOID`: cada línea referencia `original_line_id` y la cantidad
 *     a anular.
 *   - `ADDITION` (nota débito): cargo agregado. `original_line_id` puede ser
 *     null si es un concepto libre.
 *
 * FULL_VOID típicamente NO envía `lines` (el service replica el total de la
 * venta).
 */
export class CreateCreditNoteLineDto {
  @ApiPropertyOptional({
    example: 12,
    description:
      'ID de la línea de venta original (sale_invoice_lines.id). Requerido para PARTIAL_VOID. NULL para ADDITION libre.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'original_line_id debe ser entero' })
  @Min(1, { message: 'original_line_id debe ser >= 1' })
  original_line_id?: number | null;

  @ApiProperty({
    example: 1,
    description: 'ID del producto referenciado por la línea.',
  })
  @Type(() => Number)
  @IsInt({ message: 'product_id debe ser entero' })
  @Min(1, { message: 'product_id debe ser >= 1' })
  product_id!: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'ID del empaque (opcional). Debe pertenecer a la company.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'packaging_id debe ser entero' })
  @Min(1, { message: 'packaging_id debe ser >= 1' })
  packaging_id?: number | null;

  @ApiPropertyOptional({
    example: 'Aceite Diana 1L',
    description: 'Snapshot opcional del nombre. Si no viene, se toma de product.name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiProperty({ example: 2, description: 'Cantidad a anular o cargar. > 0. Hasta 4 decimales.' })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'quantity debe ser un número con hasta 4 decimales' },
  )
  @IsPositive({ message: 'quantity debe ser mayor a cero' })
  quantity!: number;

  @ApiProperty({
    example: 25.5,
    description: 'Precio unitario (snapshot). >= 0. Hasta 2 decimales.',
  })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'unit_price debe ser un número con hasta 2 decimales' },
  )
  @Min(0, { message: 'unit_price debe ser >= 0' })
  unit_price!: number;

  @ApiPropertyOptional({
    example: 16,
    description: 'Porcentaje IVA aplicado (0-100). Default 0.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'iva_percentage debe ser un número con hasta 4 decimales' },
  )
  @Min(0, { message: 'iva_percentage debe ser >= 0' })
  iva_percentage?: number;
}

/**
 * Payload de `POST /credit-notes`. Espejo PlacePos.
 *
 * El service determina la combinación legal `note_type x operation_type`
 * (rechaza con 422 cualquier combinación inválida) y calcula totales con
 * Big.js.
 */
export class CreateCreditNoteDto {
  @ApiProperty({
    example: 42,
    description: 'ID de la venta sobre la que opera la nota. Debe ser SALE (no ORDER).',
  })
  @Type(() => Number)
  @IsInt({ message: 'sale_invoice_id debe ser entero' })
  @Min(1, { message: 'sale_invoice_id debe ser >= 1' })
  sale_invoice_id!: number;

  @ApiProperty({
    enum: NoteType,
    example: NoteType.CREDIT,
    description: 'CREDIT reduce el total consolidado; DEBIT lo aumenta.',
  })
  @IsEnum(NoteType, { message: 'note_type inválido' })
  note_type!: NoteType;

  @ApiProperty({
    enum: OperationType,
    example: OperationType.FULL_VOID,
    description:
      'Combinaciones legales: CREDIT+(FULL_VOID|PARTIAL_VOID) o DEBIT+ADDITION. Cualquier otra combinación → 422.',
  })
  @IsEnum(OperationType, { message: 'operation_type inválido' })
  operation_type!: OperationType;

  @ApiPropertyOptional({
    example: 'Devolución por producto defectuoso.',
    description: 'Motivo libre.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    type: [CreateCreditNoteLineDto],
    description:
      'Líneas de la nota. Requerido para PARTIAL_VOID y ADDITION. Para FULL_VOID se omite (el total se replica de la venta).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Si envías líneas debe haber al menos una' })
  @ValidateNested({ each: true })
  @Type(() => CreateCreditNoteLineDto)
  lines?: CreateCreditNoteLineDto[];
}
