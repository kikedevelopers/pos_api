import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Configuración del flag «mostrar todos los productos base en compras» —
 * espejo de `placepos/src/renderer/src/api/requests/app-settings/types.ts →
 * ShowAllBaseProductsInPurchasesConfig`.
 *
 * `enabled=true` hace que TODOS los productos BASE (`parent_id IS NULL`)
 * aparezcan en el buscador de compras a proveedores, saltándose la validación
 * de `is_purchasable` ("Disponible para compra"). Es ADITIVO: nunca esconde lo
 * que ya aparecía. Default: false (comportamiento actual idéntico).
 *
 * El filtro es de PRESENTACIÓN (vive en el cliente, que ya recibe el catálogo
 * completo): ningún backend valida `is_purchasable` al guardar una compra.
 */
export class ShowAllBaseProductsInPurchasesConfigDto {
  @ApiProperty({ example: false })
  enabled!: boolean;
}

/**
 * Payload de `PUT /app-settings/show-all-base-products-in-purchases`.
 *
 * A diferencia de `include-orders-in-reports` (owner/superadmin), este ajuste
 * lo gestionan administradores Y dueños: basta `canAccessSettings`. No mueve
 * dinero ni datos — solo decide qué lista el buscador de compras.
 */
export class UpdateShowAllBaseProductsInPurchasesDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  enabled!: boolean;
}
