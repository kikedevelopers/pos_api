import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Product, ProductType } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';

/**
 * Shape de respuesta de packaging anidado dentro de Product. Espejo PlacePos:
 *
 *   { id, name, value }
 */
export class ProductPackagingNestedDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Caja x 12' })
  name!: string;

  @ApiProperty({ example: 12 })
  value!: number;
}

/**
 * Shape de respuesta de un precio dentro de Product. Espejo PlacePos:
 *
 *   { id, sale_price, profit, margin }
 *
 * Añadimos `name` e `iva_percentage` para los clientes nuevos. El cliente
 * PlacePos los ignora (campos opcionales backwards-compat).
 */
export class ProductPriceNestedDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: '' })
  name!: string;

  @ApiProperty({ example: 10.5 })
  sale_price!: number;

  @ApiProperty({ example: 8 })
  profit!: number;

  @ApiProperty({ example: 76.1905 })
  margin!: number;

  @ApiProperty({ example: 0 })
  iva_percentage!: number;
}

/**
 * Shape de respuesta de Product. Espejo de `normalizeProduct` en PlacePos
 * (`inventory.routes.ts`).
 *
 * Diferencias menores:
 *   - Sin `stock` / `is_purchasable` / `archived` (renombrado a
 *     `is_archived` en este API por convención CLAUDE.md §2.4).
 *   - `archived` (legacy PlacePos) ↔ `is_archived` (aquí). Mantenemos
 *     AMBOS en el response para paridad — `archived` = `is_archived` value.
 */
export class ProductResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Coca-Cola 2L' })
  name!: string;

  @ApiPropertyOptional({ example: '7591001234567', nullable: true })
  bar_code!: string | null;

  @ApiPropertyOptional({ example: 'SKU-12345', nullable: true })
  sku_code!: string | null;

  @ApiPropertyOptional({ example: 'Descripción', nullable: true })
  description!: string | null;

  @ApiProperty({ example: 2.5 })
  cost!: number;

  @ApiProperty({ example: ProductType.SIMPLE, enum: ProductType })
  product_type!: ProductType;

  @ApiPropertyOptional({ example: null, nullable: true })
  parent_id!: number | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  packaging_id!: number | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  image!: string | null;

  @ApiProperty({ example: true })
  show_in_pos!: boolean;

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiProperty({
    example: false,
    description: 'Alias legacy de `is_archived`. Mismo valor. Mantenido por paridad PlacePos.',
  })
  archived!: boolean;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  updated_by!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;

  @ApiPropertyOptional({ type: ProductPackagingNestedDto, nullable: true })
  packaging!: ProductPackagingNestedDto | null;

  @ApiProperty({ type: [ProductPriceNestedDto] })
  prices!: ProductPriceNestedDto[];
}

/**
 * Mapper Product → ProductResponseDto. Único punto donde la entidad cruda
 * (con relaciones cargadas) se proyecta a respuesta.
 */
export function toProductResponseDto(p: Product): ProductResponseDto {
  return {
    id: Number(p.id),
    name: p.name,
    bar_code: p.bar_code ?? null,
    sku_code: p.sku_code ?? null,
    description: p.description ?? null,
    cost: Number(p.cost),
    product_type: p.product_type,
    parent_id: p.parent_id === null ? null : Number(p.parent_id),
    packaging_id: p.packaging_id === null ? null : Number(p.packaging_id),
    image: p.image ?? null,
    show_in_pos: p.show_in_pos,
    is_archived: p.is_archived,
    archived: p.is_archived,
    created_by: p.created_by ?? null,
    updated_by: p.updated_by ?? null,
    created_at: p.created_at.toISOString(),
    updated_at: p.updated_at.toISOString(),
    packaging: p.packaging
      ? {
          id: Number(p.packaging.id),
          name: p.packaging.name,
          value: Number(p.packaging.value),
        }
      : null,
    prices: (p.prices ?? []).map(mapPriceNested),
  };
}

function mapPriceNested(pp: ProductPrice): ProductPriceNestedDto {
  return {
    id: Number(pp.id),
    name: pp.name ?? '',
    sale_price: Number(pp.sale_price),
    profit: Number(pp.profit),
    margin: Number(pp.margin),
    iva_percentage: Number(pp.iva_percentage),
  };
}

/**
 * Shape de respuesta minimal de `POST /inventory` y `PUT /inventory/:id`
 * (PlacePos no devuelve el producto completo en estos endpoints — devuelve
 * sólo `{ id, name, created_by/updated_by, created_at/updated_at }`).
 */
export class ProductMinimalResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Coca-Cola 2L' })
  name!: string;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by?: string | null;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  updated_by?: string | null;

  @ApiPropertyOptional({ example: '2026-05-12T14:30:00.000Z' })
  created_at?: string;

  @ApiPropertyOptional({ example: '2026-05-12T14:30:00.000Z' })
  updated_at?: string;
}

/**
 * Response de `PUT /inventory/:id/show-in-pos` (versión individual).
 */
export class ToggleShowInPosResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: true })
  show_in_pos!: boolean;
}

/**
 * Response de `PUT /inventory/:id/archive`.
 */
export class ArchiveProductResponseDto {
  @ApiProperty({ example: true })
  archived!: boolean;
}

/**
 * Response de `GET /inventory/:id/sales-history`. Placeholder Fase 3 —
 * la entidad SaleInvoiceLine no existe todavía. El service devuelve listas
 * vacías y summary en ceros para mantener el contrato HTTP.
 */
export class SalesHistoryLineDto {
  @ApiProperty({ example: 1 })
  lineId!: number;

  @ApiProperty({ example: 100 })
  invoiceId!: number;

  @ApiProperty({ example: 'A-000123' })
  ticketNumber!: string;

  @ApiPropertyOptional({ example: '0001', nullable: true })
  saleNumber!: string | null;

  @ApiProperty({ example: 'CONSUMIDOR FINAL' })
  customerName!: string;

  @ApiProperty({ example: 1 })
  quantity!: number;

  @ApiProperty({ example: 10.5 })
  price!: number;

  @ApiProperty({ example: 10.5 })
  total!: number;

  @ApiProperty({ example: 8 })
  profit!: number;

  @ApiProperty({ example: 76.1905 })
  margin!: number;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  invoiceDate!: string;
}

export class SalesHistorySummaryDto {
  @ApiProperty({ example: 0 })
  timesInvoiced!: number;

  @ApiProperty({ example: 0 })
  totalQuantity!: number;

  @ApiProperty({ example: 0 })
  totalSales!: number;

  @ApiProperty({ example: 0 })
  totalCost!: number;

  @ApiProperty({ example: 0 })
  totalProfit!: number;

  @ApiProperty({ example: 0 })
  averageMargin!: number;
}

export class SalesHistoryResponseDto {
  @ApiProperty({ type: [SalesHistoryLineDto] })
  sales!: SalesHistoryLineDto[];

  @ApiProperty({ type: SalesHistorySummaryDto })
  summary!: SalesHistorySummaryDto;
}
