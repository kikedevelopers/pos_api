import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
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

  // ─────────────────────────────────────────────────────────────────────────
  // Carrier / transport (B-1)
  // ─────────────────────────────────────────────────────────────────────────

  @ApiPropertyOptional({
    example: 7,
    nullable: true,
    description: 'ID del transportista. Si `transport_cost > 0` es obligatorio.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'carrier_id debe ser entero' })
  @Min(1, { message: 'carrier_id debe ser >= 1' })
  carrier_id?: number | null;

  @ApiPropertyOptional({
    example: 25.5,
    nullable: true,
    description: 'Costo total del flete. Genera/reconcilia `CarrierCredit`.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'transport_cost debe ser número con hasta 2 decimales' },
  )
  @Min(0, { message: 'transport_cost debe ser >= 0' })
  transport_cost?: number | null;

  @ApiPropertyOptional({
    example: 1200.5,
    nullable: true,
    description: 'Peso total transportado en kg. Hasta 4 decimales.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'total_kilos debe ser número con hasta 4 decimales' },
  )
  @Min(0, { message: 'total_kilos debe ser >= 0' })
  total_kilos?: number | null;

  @ApiPropertyOptional({
    enum: PURCHASE_PAYMENT_SOURCE_TYPES,
    example: 'bank',
    description:
      'Tipo de cuenta destino del reembolso al transportista cuando el nuevo transport_cost queda por debajo de lo ya pagado al carrier. Obligatorio si hay excedente.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @IsIn([...PURCHASE_PAYMENT_SOURCE_TYPES], {
    message: 'Fuente del reembolso al transportista inválida. Usa wallet, bank o cash_register.',
  })
  refund_carrier_source_type?: PurchasePaymentSource | null;

  @ApiPropertyOptional({
    example: 1,
    nullable: true,
    description: 'ID de la cuenta destino del reembolso al transportista.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'refund_carrier_source_id debe ser entero' })
  @Min(1, { message: 'refund_carrier_source_id debe ser >= 1' })
  refund_carrier_source_id?: number | null;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    nullable: true,
    description:
      'UUID v4 generado por el cliente (idempotencia de la edición). Aceptado por ' +
      'paridad PlacePos; la idempotencia server-side completa está pendiente.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID('4', { message: 'client_operation_id debe ser un UUID v4 válido' })
  client_operation_id?: string | null;
}
