import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  PURCHASE_PAYMENT_SOURCE_TYPES,
  type PurchasePaymentSource,
} from './create-purchase-payment.dto';
import { CreatePurchaseLineDto } from './create-purchase.dto';

/**
 * Payload de `PUT /purchases/:id`. Espejo PlacePos `UpdatePurchaseBody`
 * con las siguientes diferencias justificadas por el esquema cloud actual:
 *
 *   - **No incluye `carrier_id`/`transport_cost`/`total_kilos`**: la entidad
 *     `Purchase` cloud aún no modela carrier ni flete (paridad incompleta a
 *     propósito — esa fase llega después). Si el cliente PlacePos envía esos
 *     campos, `forbidNonWhitelisted` los rechaza con 400.
 *   - **No incluye `refund_carrier_source_*`**: idem, no aplica sin carrier.
 *   - **Mantiene `invoice_date`/`invoice_number`**: las columnas existen.
 *   - **Mantiene `force_stock_adjustment`**: el helper de inventario es STUB
 *     pero la bandera se persiste en el log para auditoría futura.
 *   - **Mantiene `refund_source_type`/`refund_source_id`**: cuando el nuevo
 *     total queda por debajo de lo ya pagado, el exceso vuelve a la caja
 *     escogida con FinancialMovement (INCOME, ADJUSTMENT).
 *
 * El `supplier_id` NO se acepta — por diseño es inmutable en edición (paridad
 * PlacePos). Cambiar de proveedor = archivar + crear nueva compra.
 */
export class UpdatePurchaseDto {
  @ApiProperty({
    example: '2026-05-12',
    description: 'Fecha de la factura del proveedor (ISO 8601 YYYY-MM-DD).',
  })
  @IsDateString({}, { message: 'invoice_date debe ser una fecha ISO 8601 válida' })
  invoice_date!: string;

  @ApiPropertyOptional({ example: 'F-1234', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invoice_number?: string | null;

  @ApiProperty({
    type: [CreatePurchaseLineDto],
    description: 'Reemplazo COMPLETO de las líneas. Al menos una.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'La compra debe contener al menos un producto' })
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseLineDto)
  lines!: CreatePurchaseLineDto[];

  @ApiPropertyOptional({
    example: false,
    description:
      'Si true, permite clampear el stock a 0 cuando el delta negativo dejaría inventario negativo. Solo aceptado para owner/superadmin. Default false.',
  })
  @IsOptional()
  @IsBoolean()
  force_stock_adjustment?: boolean;

  @ApiPropertyOptional({
    enum: PURCHASE_PAYMENT_SOURCE_TYPES,
    example: 'cash_register',
    description:
      'Tipo de fuente que recibe el reembolso cuando el nuevo total queda por debajo de lo ya pagado. Obligatorio si hay excedente; ignorado en caso contrario.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @IsIn([...PURCHASE_PAYMENT_SOURCE_TYPES], {
    message: 'Fuente del reembolso inválida. Usa wallet, bank o cash_register.',
  })
  refund_source_type?: PurchasePaymentSource | null;

  @ApiPropertyOptional({
    example: 1,
    description: 'ID de la cuenta destino del reembolso (debe pertenecer a la company).',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'refund_source_id debe ser entero' })
  @Min(1, { message: 'refund_source_id debe ser >= 1' })
  refund_source_id?: number | null;
}
