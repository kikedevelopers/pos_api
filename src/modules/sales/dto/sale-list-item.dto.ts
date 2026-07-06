import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { TicketType } from '../entities/sale-invoice.entity';

/**
 * Item de la lista cronológica de ventas. Espejo byte-por-byte de
 * `TicketListItem` de PlacePos (`placepos/src/main/database/types.ts`) +
 * los campos `cost`, `profit`, `margin` que el renderer del POS también lee
 * (ver `placepos/src/renderer/src/modules/PointOfSale/components/DailySales/
 * hooks/useDailySales.ts → interface Ticket`).
 *
 * camelCase exigido por el cliente — el renderer hace
 * `ticket.customerName.toLowerCase()` y `ticket.ticketNumber.toLowerCase()`.
 * Si se envía snake_case explota con "Cannot read properties of undefined".
 *
 * Totales `total`/`cost`/`profit`/`margin` ya consolidados (V + ND − NC).
 * Paridad con `getTickets` del modo servidor/cliente.
 */
export class SaleListItemDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ enum: TicketType, example: TicketType.ORDER })
  ticketType!: TicketType;

  @ApiProperty({ example: '001' })
  ticketNumber!: string;

  @ApiPropertyOptional({ example: '001', nullable: true })
  saleNumber!: string | null;

  @ApiProperty({ example: 116 })
  total!: number;

  @ApiProperty({ example: 60 })
  cost!: number;

  @ApiProperty({ example: 56 })
  profit!: number;

  @ApiProperty({ example: 48.2759 })
  margin!: number;

  @ApiProperty({ example: true, description: 'La venta es a crédito (tiene registro de crédito).' })
  isCredit!: boolean;

  @ApiPropertyOptional({
    enum: ['PENDING', 'PARTIAL', 'PAID'],
    nullable: true,
    example: 'PENDING',
    description: 'Estado del crédito (normalizado a vocabulario PlacePos). null si no es crédito.',
  })
  creditStatus!: 'PENDING' | 'PARTIAL' | 'PAID' | null;

  @ApiProperty({
    example: 'Juan Pérez',
    description:
      "Snapshot del nombre del cliente. Mostrador → 'CONSUMIDOR FINAL' (paridad PlacePos).",
  })
  customerName!: string;

  @ApiProperty({ example: true, description: 'Siempre true en modo cloud (no hay offline sync).' })
  synced!: boolean;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  createdAt!: string;
}
