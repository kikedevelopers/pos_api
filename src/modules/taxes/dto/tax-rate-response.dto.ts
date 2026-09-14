import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { preciseNumber } from '@/common/utils/precision';
import type { TaxRate } from '../entities/tax-rate.entity';

/**
 * Fila del catálogo de IVA tal como la consume el cliente (select del
 * formulario de producto: muestra `name` como valor y `description` debajo).
 */
export class TaxRateResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'IVA_19' })
  code!: string;

  @ApiProperty({ example: 'IVA 19%' })
  name!: string;

  @ApiProperty({ example: 19, description: 'Tarifa porcentual.' })
  rate!: number;

  @ApiPropertyOptional({ example: 'Tarifa general…', nullable: true })
  description!: string | null;

  @ApiProperty({ example: 1 })
  sort_order!: number;
}

export function toTaxRateResponseDto(tax: TaxRate): TaxRateResponseDto {
  return {
    id: Number(tax.id),
    code: tax.code,
    name: tax.name,
    rate: preciseNumber(tax.rate, 2),
    description: tax.description,
    sort_order: tax.sort_order,
  };
}
