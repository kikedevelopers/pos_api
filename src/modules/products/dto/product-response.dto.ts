import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Product, ProductType } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';
import {
  computeChildStockDisplay,
  computeStockDisplay,
} from '@/modules/products/internal/compute-stock-display';

/**
 * Shape de respuesta de packaging anidado dentro de Product. Espejo PlacePos:
 *
 *   { id, name, value, is_auto }
 */
export class ProductPackagingNestedDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Caja x 12' })
  name!: string;

  @ApiProperty({ example: 12 })
  value!: number;

  @ApiProperty({
    example: false,
    description:
      'Empaque auto del sistema (presentación de peso/monto variable). El cliente lo usa para abrir el formulario en el modo correcto al editar.',
  })
  is_auto!: boolean;
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
 *   - `archived` (legacy PlacePos) ↔ `is_archived` (aquí). Mantenemos
 *     AMBOS en el response para paridad — `archived` = `is_archived` value.
 *   - `stock_display` se calcula a partir de `stock` y `packaging.value`.
 *     Por ahora lo igualamos a `stock` (el cliente lo ignora si el
 *     packaging no aplica). El cálculo final contra `packaging.value` se
 *     puede mover aquí sin romper el contrato.
 */
export class ProductPriceCategoryNestedDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Bebidas' })
  name!: string;
}

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

  @ApiProperty({ example: 10, description: 'Stock unitario en unidad mínima.' })
  stock!: number;

  @ApiProperty({
    example: 10,
    description: 'Stock mostrado al usuario. Por ahora igual a `stock`.',
  })
  stock_display!: number;

  @ApiProperty({ example: ProductType.SIMPLE, enum: ProductType })
  product_type!: ProductType;

  @ApiPropertyOptional({ example: null, nullable: true })
  parent_id!: number | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  packaging_id!: number | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  category_id!: number | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  image!: string | null;

  @ApiProperty({ example: true })
  show_in_pos!: boolean;

  @ApiProperty({ example: false })
  is_purchasable!: boolean;

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

  @ApiPropertyOptional({ type: ProductPriceCategoryNestedDto, nullable: true })
  category!: ProductPriceCategoryNestedDto | null;

  @ApiProperty({ type: [ProductPriceNestedDto] })
  prices!: ProductPriceNestedDto[];

  /**
   * Fecha (ISO) de la última compra RECIBIDA que incluyó el producto. `null` si
   * nunca se ha recibido una compra con él (el front cae a `created_at`). Solo
   * la puebla el listado (`FindAllProductsAction`); en respuestas de un solo
   * producto va `null`.
   */
  @ApiPropertyOptional({ example: '2026-07-20T14:30:00.000Z', nullable: true })
  last_purchase_date!: string | null;

  /**
   * FASE 2 (COMPARTIR): `true` si el producto NO es de la company activa sino
   * compartido por el principal. El front lo trata como SOLO LECTURA (no editar,
   * no cambiar precio, no comprar). `false`/ausente para productos propios.
   */
  @ApiProperty({ example: false })
  is_shared!: boolean;

  /** Company DUEÑA real del producto (el principal si es compartido). */
  @ApiProperty({ example: 9 })
  owner_company_id!: number;

  /**
   * SUCURSALES (CLONAR): `true` si el producto es una COPIA clonada desde el
   * principal (es propio de la sucursal, editable). `false` = creado aquí
   * ("Propio"). Distinto de `is_shared` (que es de otra company, solo lectura).
   */
  @ApiProperty({ example: false })
  is_clone!: boolean;
}

/**
 * Mapper Product → ProductResponseDto. Único punto donde la entidad cruda
 * (con relaciones cargadas) se proyecta a respuesta.
 *
 * `parentStock` (opcional): cuando el producto es una presentación
 * (`parent_id != null`), el caller debe pasar el `stock` del padre para que
 * `stock_display` se calcule como `parentStock / childPackagingValue`
 * (espejo PlacePos `normalizeChildProduct`). Si no se pasa o es null, se cae
 * al stock crudo del propio hijo.
 *
 * Para productos base (sin parent), el cálculo es
 * `stock / packaging.value` (PlacePos `normalizeProduct`).
 */
export function toProductResponseDto(
  p: Product,
  parentStock: number | null = null,
): ProductResponseDto {
  const stock = Number(p.stock);
  const packagingValue = p.packaging ? Number(p.packaging.value) : null;
  const isChild = p.parent_id !== null && p.parent_id !== undefined;
  const stockDisplay = isChild
    ? computeChildStockDisplay(parentStock, stock, packagingValue)
    : computeStockDisplay(stock, packagingValue);
  return {
    id: Number(p.id),
    name: p.name,
    bar_code: p.bar_code ?? null,
    sku_code: p.sku_code ?? null,
    description: p.description ?? null,
    cost: Number(p.cost),
    stock,
    stock_display: stockDisplay,
    product_type: p.product_type,
    parent_id: p.parent_id === null ? null : Number(p.parent_id),
    packaging_id: p.packaging_id === null ? null : Number(p.packaging_id),
    category_id: p.category_id === null ? null : Number(p.category_id),
    image: p.image ?? null,
    show_in_pos: p.show_in_pos,
    is_purchasable: p.is_purchasable,
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
          is_auto: p.packaging.is_auto === true,
        }
      : null,
    category: p.category
      ? {
          id: Number(p.category.id),
          name: p.category.name,
        }
      : null,
    prices: (p.prices ?? []).map(mapPriceNested),
    // Solo el listado adjunta `last_purchase_date` al POJO; en un solo producto
    // (entidad real) va null.
    last_purchase_date:
      (p as unknown as { last_purchase_date?: string | null }).last_purchase_date ?? null,
    // FASE 2: `is_shared`/`owner_company_id` los adjunta FindAllProductsAction al
    // POJO. Para entidades propias normales (sin el campo) → no compartido.
    is_shared: (p as ProductWithSharing).is_shared === true,
    owner_company_id:
      (p as ProductWithSharing).owner_company_id !== undefined
        ? Number((p as ProductWithSharing).owner_company_id)
        : Number(p.company_id),
    is_clone:
      (p as ProductWithSharing).is_clone !== undefined
        ? (p as ProductWithSharing).is_clone === true
        : p.cloned_from_company_id != null,
  };
}

/**
 * Product POJO extendido por FindAllProductsAction (FASE 2) con metadatos de
 * compartición. No es parte de la entidad TypeORM; se adjunta al mapear.
 */
interface ProductWithSharing {
  is_shared?: boolean;
  owner_company_id?: number;
  is_clone?: boolean;
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
 * @deprecated Fase 3A — el endpoint single `PUT /:id/show-in-pos` fue
 * reemplazado por el bulk `PUT /inventory/show-in-pos`. Ver
 * `BulkToggleShowInPosResponseDto`. Se conserva por si algún cliente
 * externo lo referencia; será removido en una versión posterior.
 */
export class ToggleShowInPosResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: true })
  show_in_pos!: boolean;
}

/**
 * @deprecated Fase 3A — el endpoint single `PUT /:id/archive` fue
 * reemplazado por el bulk `PUT /inventory/archive`. Ver
 * `BulkArchiveProductsResponseDto`.
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
