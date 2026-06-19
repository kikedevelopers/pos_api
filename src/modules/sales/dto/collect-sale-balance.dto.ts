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
  IsUUID,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { SalePaymentMethod } from '../entities/sale-payment.entity';

/**
 * Un tender del re-cobro de saldo. Espejo del tender de `POST /payments`
 * (CASH/TRANSFER). El crédito NO es un tender: el remanente que quede tras el
 * re-cobro se gestiona vía SaleCredit por el recompute de settlement.
 */
export class CollectSaleTenderDto {
  @ApiProperty({
    description: 'Método de este tender.',
    enum: [SalePaymentMethod.CASH, SalePaymentMethod.TRANSFER],
    example: SalePaymentMethod.CASH,
  })
  @IsEnum(SalePaymentMethod)
  payment_method!: SalePaymentMethod;

  @ApiProperty({ description: 'Monto entregado por este método.', example: 100 })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  amount_paid!: number;

  @ApiPropertyOptional({
    description: 'Vuelto. Sólo CASH con sobrepago; TRANSFER siempre 0. Default 0.',
    example: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  change_amount?: number;

  @ApiPropertyOptional({
    description: 'Id del banco receptor. Requerido cuando payment_method=TRANSFER.',
    example: 7,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @IsPositive()
  bank_id?: number | null;

  @ApiPropertyOptional({
    description: 'Nombre del banco (snapshot persistido en el SalePayment).',
    example: 'Bancolombia Ahorros',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  bank_name?: string | null;
}

/**
 * Body de `POST /sales/:saleId/collect` — re-cobro del saldo pendiente de una
 * venta SALE (tras un reverso de pago, o cobro de un crédito desde el ticket).
 *
 * No regenera folio ni descuenta inventario (la venta ya es SALE). Solo
 * inserta SalePayment(s) + acredita destinos + recomputa el settlement.
 */
export class CollectSaleBalanceDto {
  @ApiProperty({
    description: 'Tenders del re-cobro (1..N). Sólo CASH/TRANSFER.',
    type: [CollectSaleTenderDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CollectSaleTenderDto)
  payments!: CollectSaleTenderDto[];

  @ApiPropertyOptional({
    description:
      'UUID v4 generado por el cliente para la intención de re-cobro. Idempotencia: un reintento con la misma llave devuelve el cobro previo sin duplicar.',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID(4)
  client_operation_id?: string;
}
