import { ApiProperty } from '@nestjs/swagger';

/**
 * Item genérico de fuente de efectivo (wallet / bank / cash_register).
 */
export class CashSourceItemDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Efectivo' })
  name!: string;

  @ApiProperty({ example: 250.5 })
  balance!: number;

  @ApiProperty({
    example: 'wallet',
    enum: ['wallet', 'bank', 'cash_register'],
    description: 'Discriminador del tipo de fuente.',
  })
  type!: 'wallet' | 'bank' | 'cash_register';
}

/**
 * Respuesta de `GET /cash-sources`. Espejo PlacePos.
 */
export class CashSourcesResponseDto {
  @ApiProperty({ type: [CashSourceItemDto] })
  wallets!: CashSourceItemDto[];

  @ApiProperty({ type: [CashSourceItemDto] })
  banks!: CashSourceItemDto[];

  @ApiProperty({
    type: [CashSourceItemDto],
    description: 'Solo la caja del usuario logueado (si está abierta).',
  })
  cash_registers!: CashSourceItemDto[];
}
