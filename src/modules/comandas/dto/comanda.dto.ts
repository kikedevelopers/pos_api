import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';
import type { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';

/**
 * Una línea de la comanda: qué y cuánto preparar. `name` es el snapshot del
 * nombre del producto (`sale_invoice_lines.description`); `note` es la nota de
 * cocina por línea (p. ej. "sin cebolla"), opcional.
 */
export class ComandaLineDto {
  @ApiProperty({ example: 'Hamburguesa clásica' })
  name!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiPropertyOptional({ nullable: true, example: 'Sin cebolla' })
  note!: string | null;
}

/**
 * Una comanda = un pedido ORDER activo (sin cobrar ni anular) listo para que la
 * cocina/meseros lo preparen. Expone fecha/hora de registro, mesa (o salón +
 * mesa), cliente y el detalle de productos. La lista llega en orden FIFO (del
 * más viejo al más nuevo) desde la action.
 */
export class ComandaDto {
  @ApiProperty({ example: 142 })
  id!: number;

  @ApiProperty({ example: 'PED-8270' })
  ticketNumber!: string;

  @ApiProperty({
    example: '2026-10-06T14:30:00.000Z',
    description: 'Instante de registro del pedido (ISO 8601). La lista se ordena por este campo ASC.',
  })
  createdAt!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Mesa 5' })
  tableName!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Sur A' })
  salonName!: string | null;

  @ApiProperty({ example: 'Juan Pérez', description: "Mostrador → 'CONSUMIDOR FINAL'." })
  customerName!: string;

  @ApiProperty({ type: [ComandaLineDto] })
  lines!: ComandaLineDto[];
}

/** Mapea un pedido + sus líneas (ya resueltas) a la comanda del contrato HTTP. */
export function toComandaDto(order: SaleInvoice, lines: SaleInvoiceLine[]): ComandaDto {
  return {
    id: Number(order.id),
    ticketNumber: order.ticket_number,
    createdAt: order.created_at.toISOString(),
    tableName: order.table_name ?? null,
    salonName: order.salon_name ?? null,
    customerName: order.customer_name || 'CONSUMIDOR FINAL',
    lines: lines.map((line) => ({
      name: line.description,
      quantity: Number(line.quantity),
      note: line.note ?? null,
    })),
  };
}
