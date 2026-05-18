import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ProductPackagingNestedDto } from './product-response.dto';

/**
 * Cabecera "producto" del response: el producto resuelto (puede ser el
 * padre si la URL apuntaba a una presentación).
 */
export class PriceComparisonProductDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Coca-Cola 2L' })
  name!: string;

  @ApiPropertyOptional({ example: 'SKU-123', nullable: true })
  sku_code!: string | null;

  @ApiPropertyOptional({ type: ProductPackagingNestedDto, nullable: true })
  packaging!: ProductPackagingNestedDto | null;
}

/**
 * Último precio de compra registrado a un proveedor para el producto.
 */
export class PriceComparisonSupplierDto {
  @ApiProperty({ example: 3 })
  supplier_id!: number;

  @ApiProperty({ example: 'Distribuidora ACME' })
  supplier_name!: string;

  @ApiProperty({ example: 200 })
  last_purchase_id!: number;

  @ApiProperty({ example: '2026-04-01T00:00:00.000Z' })
  last_purchase_date!: string;

  @ApiProperty({ example: 15 })
  packaging_price!: number;

  @ApiProperty({ example: 1.5 })
  unit_price!: number;
}

/**
 * Respuesta de `GET /inventory/:id/price-comparison`.
 */
export class PriceComparisonResponseDto {
  @ApiProperty({ type: PriceComparisonProductDto })
  product!: PriceComparisonProductDto;

  @ApiProperty({ example: 7 })
  requested_product_id!: number;

  @ApiProperty({ example: false })
  resolved_to_parent!: boolean;

  @ApiProperty({ type: [PriceComparisonSupplierDto] })
  suppliers!: PriceComparisonSupplierDto[];
}
