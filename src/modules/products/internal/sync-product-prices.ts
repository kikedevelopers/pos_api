import { type EntityManager, In } from 'typeorm';

import { calculateMargin, calculateProfit } from '@/common/utils/precision';

import type { ProductPriceInputDto } from '../dto/product-price.dto';
import { ProductPrice } from '../entities/product-price.entity';

import { translateProductPriceDeleteError } from './constraint-errors';

/**
 * Precio ya persistido del producto, en la forma mínima que necesita el sync.
 */
export interface ExistingPriceRef {
  id: string | number;
}

/**
 * Resultado del emparejamiento: qué precio entrante escribe sobre qué fila
 * existente (`targetId`) y qué filas quedan huérfanas (`toDelete`).
 */
export interface PricePairing {
  pairs: Array<{ input: ProductPriceInputDto; targetId: string | null }>;
  toDelete: string[];
}

/**
 * Empareja los precios entrantes con los existentes.
 *
 * Dos modos:
 *
 *   1. **Por id** (cliente moderno): al menos un precio entrante trae `id`.
 *      El array es fuente de verdad — los `id` presentes se actualizan, los
 *      ausentes se insertan y las filas existentes que no aparecen se borran.
 *
 *   2. **Por posición** (cliente legacy): NINGÚN precio entrante trae `id`.
 *      PlacePos ≤ 1.0.0 reconstruye el array del formulario con sólo
 *      `sale_price/profit/margin`, así que el modo 1 leería "borra todos e
 *      inserta de nuevo". Ese DELETE explota contra las FKs de
 *      `sale_invoice_lines` / `product_price_history` en cuanto el producto se
 *      vendió o entró por una compra → el usuario no podía editar el precio.
 *      Emparejando por posición (existentes ordenados por id ascendente,
 *      mismo orden en que el cliente los pinta) hacemos UPDATE in-place: sin
 *      DELETE no hay violación de FK y el historial queda intacto.
 *
 * En ambos modos los precios entrantes de más se insertan y los existentes
 * sobrantes se borran (el cliente quitó un nivel de precio de verdad).
 */
export function pairIncomingPrices(
  incoming: ProductPriceInputDto[],
  existing: ExistingPriceRef[],
): PricePairing {
  // Orden estable por id ascendente = orden de creación = orden en que el
  // cliente lista los niveles de precio.
  const existingIds = existing
    .map((price) => String(price.id))
    .sort((a, b) => Number(a) - Number(b));

  const hasIncomingIds = incoming.some((price) => price.id !== undefined);

  const pairs = incoming.map((input, index) => ({
    input,
    targetId: hasIncomingIds
      ? input.id !== undefined && existingIds.includes(String(input.id))
        ? String(input.id)
        : null
      : (existingIds[index] ?? null),
  }));

  const keptIds = new Set(
    pairs.map((pair) => pair.targetId).filter((id): id is string => id !== null),
  );
  const toDelete = existingIds.filter((id) => !keptIds.has(id));

  return { pairs, toDelete };
}

interface SyncProductPricesArgs {
  manager: EntityManager;
  companyId: number;
  productId: string;
  /** Costo contra el que se recalculan profit/margin de TODOS los precios. */
  cost: number;
  incoming: ProductPriceInputDto[];
  existing: ExistingPriceRef[];
  actor: { id: number; fullName: string };
}

/**
 * Sincroniza los `product_prices` de un producto contra el array recibido en
 * `PUT /inventory/:id`. `profit`/`margin` SIEMPRE se recalculan con Big.js —
 * los hints del cliente se ignoran.
 */
export async function syncProductPrices(args: SyncProductPricesArgs): Promise<void> {
  const { manager, companyId, productId, cost, incoming, existing, actor } = args;

  const { pairs, toDelete } = pairIncomingPrices(incoming, existing);

  if (toDelete.length > 0) {
    try {
      await manager.delete(ProductPrice, {
        id: In(toDelete),
        product_id: productId,
        company_id: String(companyId),
      });
    } catch (error) {
      translateProductPriceDeleteError(error);
      throw error;
    }
  }

  for (const { input, targetId } of pairs) {
    const profit = calculateProfit(input.sale_price, cost);
    const margin = calculateMargin(input.sale_price, cost);

    if (targetId !== null) {
      // UPDATE — filtra por id + product_id + company_id (defensa en
      // profundidad anti cross-tenant).
      await manager.update(
        ProductPrice,
        { id: targetId, product_id: productId, company_id: String(companyId) },
        {
          name: input.name ?? '',
          sale_price: input.sale_price,
          profit,
          margin,
          iva_percentage: input.iva_percentage ?? 0,
        },
      );
    } else {
      // INSERT — nuevo nivel de precio.
      await manager.insert(ProductPrice, {
        company_id: String(companyId),
        product_id: productId,
        name: input.name ?? '',
        sale_price: input.sale_price,
        profit,
        margin,
        iva_percentage: input.iva_percentage ?? 0,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      });
    }
  }
}
