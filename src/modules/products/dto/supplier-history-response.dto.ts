import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Una línea del historial de compras del producto a un proveedor.
 * Espejo de `placepos/inventory.routes.ts` líneas 537-551.
 */
export class SupplierHistoryLineDto {
  @ApiProperty({ example: 100 })
  purchase_id!: number;

  @ApiProperty({ example: 'C-000123' })
  purchase_number!: string;

  @ApiProperty({ example: '2026-05-01T00:00:00.000Z' })
  invoice_date!: string;

  @ApiProperty({ example: 5 })
  packaging_qty!: number;

  @ApiProperty({ example: 12.5 })
  unit_qty!: number;

  @ApiProperty({ example: 1.5 })
  unit_price!: number;

  @ApiProperty({ example: 15 })
  packaging_price!: number;

  @ApiProperty({ example: 75 })
  total!: number;

  @ApiPropertyOptional({ example: 'Caja x 12', nullable: true })
  packaging_name!: string | null;
}

/**
 * Respuesta de `GET /inventory/:productId/supplier-history/:supplierId`.
 *
 * Si el `productId` pedido es una presentación (parent_id != null), el
 * historial se busca con el id del padre (donde realmente viven las
 * `purchase_lines`). `resolved_to_parent` indica si esto ocurrió.
 */
export class SupplierHistoryResponseDto {
  @ApiProperty({ example: 7, description: 'ID del producto solicitado en la URL.' })
  product_id!: number;

  @ApiProperty({
    example: true,
    description:
      'true si el producto era una presentación y el historial se resolvió al producto padre.',
  })
  resolved_to_parent!: boolean;

  @ApiProperty({ example: 3 })
  supplier_id!: number;

  @ApiProperty({ type: [SupplierHistoryLineDto] })
  lines!: SupplierHistoryLineDto[];
}
