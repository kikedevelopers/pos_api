import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

import {
  PURCHASE_PAYMENT_SOURCE_TYPES,
  type PurchasePaymentSource,
} from './create-purchase-payment.dto';

/**
 * Payload de `PUT /purchases/:id/archive`. Espejo PlacePos
 * `ArchivePurchaseBody`.
 *
 * Cuando la compra tiene pagos aplicados (proveedor o transportista), el
 * cliente DEBE enviar `refund_source_type` + `refund_source_id` indicando
 * a qué caja se acreditan los reembolsos. Si la compra no tiene pagos,
 * estos campos son opcionales (la action no exige nada).
 *
 * `force_stock_adjustment` solo lo aceptan owner/superadmin para clampear
 * stock a 0 si una reversión dejaría inventario negativo.
 */
export class ArchivePurchaseDto {
  @ApiPropertyOptional({
    enum: PURCHASE_PAYMENT_SOURCE_TYPES,
    example: 'cash_register',
    description:
      'Tipo de cuenta destino del reembolso. Obligatorio si la compra tiene pagos aplicados (a la compra o al transportista).',
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
    nullable: true,
    description: 'ID de la cuenta destino del reembolso.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'refund_source_id debe ser entero' })
  @Min(1, { message: 'refund_source_id debe ser >= 1' })
  refund_source_id?: number | null;

  @ApiPropertyOptional({
    example: false,
    description:
      'Si true y la compra está RECEIVED, clampea stock a 0 cuando una reversión dejaría inventario negativo. Solo owner/superadmin.',
  })
  @IsOptional()
  @IsBoolean()
  force_stock_adjustment?: boolean;
}
