import { BadRequestException } from '@nestjs/common';

import { ProductType } from '@/modules/products/entities/product.entity';

/**
 * Tipos de producto que pueden aparecer en una línea de venta.
 *
 * `COMBO` entra aquí porque `adjustInventory` lo explota en su receta y
 * descuenta de los COMPONENTES, nunca del combo (que no tiene stock propio).
 * Si en el futuro aparece un tipo nuevo NO vendible, basta con no añadirlo.
 *
 * Las PRESENTACIONES no necesitan mención: son `SIMPLE` con `parent_id`, y el
 * motor de inventario ya las resuelve contra el stock del padre.
 */
const SELLABLE_TYPES: ReadonlySet<ProductType> = new Set([ProductType.SIMPLE, ProductType.COMBO]);

/** Mínimo que el guard necesita de un producto (evita acoplarse a la entidad). */
export interface SellableProductRef {
  name: string;
  product_type: ProductType;
  is_archived: boolean;
}

/**
 * Rechaza líneas de venta cuyo producto no sea vendible o esté archivado.
 *
 * Los dos motivos se reportan por separado a propósito: "no es vendible" y
 * "está archivado" mandan al usuario a acciones distintas (revisar el catálogo
 * vs restaurar el producto). El tipo se valida PRIMERO porque es el defecto más
 * estructural de los dos.
 *
 * @throws BadRequestException con el nombre del primer producto ofensor.
 */
export function assertSellableProducts(products: readonly SellableProductRef[]): void {
  const invalidType = products.find((p) => !SELLABLE_TYPES.has(p.product_type));
  if (invalidType) {
    throw new BadRequestException(
      `El producto "${invalidType.name}" no es un producto disponible para venta`,
    );
  }
  const archived = products.find((p) => p.is_archived);
  if (archived) {
    throw new BadRequestException(`El producto "${archived.name}" está archivado`);
  }
}
