import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

import { SalePaymentMethod } from '@/modules/sales/entities/sale-payment.entity';

/**
 * Métodos de pago aceptados por `POST /credits` — espejo PlacePos
 * `ProcessCreditPaymentPayload.payment_method` (solo CASH | TRANSFER).
 */
export type CreditPaymentMethod = SalePaymentMethod.CASH | SalePaymentMethod.TRANSFER;

/**
 * DTO de entrada para `POST /credits` — espejo byte-por-byte del
 * `ProcessCreditPaymentPayload` de PlacePos
 * (`placepos/src/main/database/creditPaymentOperations.ts`).
 *
 * Reglas de paridad:
 *
 *   - `invoice_id`: id entero de la `SaleInvoice` que tiene crédito pendiente.
 *     Multi-tenant: el service filtra adicionalmente por `company_id` del JWT.
 *
 *   - `payment_method`: solo `CASH` | `TRANSFER` (otros métodos del enum
 *     `SalePaymentMethod` no aplican aquí).
 *
 *   - `amount`: monto del abono en pesos. PlacePos lo envía como `number`.
 *     Validamos > 0 y la action valida contra `balance` con Big.js.
 *
 *   - `bank_id` / `bank_name`: requeridos si `payment_method = TRANSFER`,
 *     deben ser `null` si `CASH`. Snapshot del banco (sin FK formal — espejo
 *     PlacePos).
 */
export class ProcessCreditPaymentDto {
  @ApiProperty({
    description: 'ID de la SaleInvoice con crédito pendiente.',
    type: 'integer',
    example: 42,
  })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  invoice_id!: number;

  @ApiProperty({
    description: 'Método de pago del abono. Espejo PlacePos (CASH | TRANSFER).',
    enum: [SalePaymentMethod.CASH, SalePaymentMethod.TRANSFER],
    example: SalePaymentMethod.CASH,
  })
  @IsEnum(SalePaymentMethod)
  payment_method!: CreditPaymentMethod;

  @ApiProperty({
    description: 'Monto del abono en pesos. Debe ser > 0 y <= balance pendiente.',
    type: 'number',
    example: 50000,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({
    description: 'ID del banco receptor. Requerido si payment_method = TRANSFER, null si CASH.',
    type: 'integer',
    nullable: true,
    example: 7,
  })
  @ValidateIf((dto: ProcessCreditPaymentDto) => dto.payment_method === SalePaymentMethod.TRANSFER)
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @IsOptional()
  bank_id!: number | null;

  @ApiPropertyOptional({
    description:
      'Snapshot del nombre del banco al momento del abono. Opcional — la action lo resuelve si viene null.',
    type: 'string',
    nullable: true,
    example: 'Bancolombia Ahorros',
  })
  @IsOptional()
  @IsString()
  bank_name!: string | null;
}
