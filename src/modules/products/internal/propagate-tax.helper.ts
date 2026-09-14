import { In, type EntityManager } from 'typeorm';

import { computeTaxBreakdown } from '@/common/utils/precision';

import { Product } from '../entities/product.entity';
import { ProductPrice } from '../entities/product-price.entity';

/**
 * Propaga la configuración fiscal (IVA) de un producto BASE a TODAS sus
 * presentaciones (hijos por `parent_id`).
 *
 * Regla de negocio: una presentación está SIEMPRE amarrada al IVA de su base —
 * nunca tiene tarifa propia. Cuando el base cambia de tarifa (p. ej. 19% → 5%),
 * toda la familia debe seguirlo:
 *
 *   1. `tax_rate_id` de cada hijo := el del base.
 *   2. El desglose de CADA precio de cada hijo se recalcula con la nueva tarifa
 *      (`iva_percentage`, `taxable_base`, `tax_amount`). El `sale_price` (total
 *      con IVA incluido) NO cambia: lo que se ajusta es cuánto de ese total es
 *      IVA, exactamente como en el propio base.
 *
 * Idempotente y multi-tenant (todo filtra por `company_id`). Las presentaciones
 * son hojas (un base tiene hijos; un hijo no tiene hijos), así que un solo nivel.
 */
export async function propagateTaxToChildren(args: {
  manager: EntityManager;
  companyId: number;
  parentId: number;
  /** tax_rate_id final del base (null = Exento). */
  taxRateId: number | null;
  /** Tarifa porcentual ya resuelta del base. */
  taxRatePercent: number;
}): Promise<{ updatedChildren: number; updatedPrices: number }> {
  const { manager, companyId, parentId, taxRateId, taxRatePercent } = args;

  const children = await manager.find(Product, {
    where: { parent_id: String(parentId), company_id: String(companyId) },
    select: { id: true },
  });
  if (children.length === 0) {
    return { updatedChildren: 0, updatedPrices: 0 };
  }
  const childIds = children.map((c) => c.id);

  // 1. La referencia fiscal de cada hijo pasa a ser la del base.
  await manager.update(
    Product,
    { id: In(childIds), company_id: String(companyId) },
    { tax_rate_id: taxRateId !== null ? String(taxRateId) : null },
  );

  // 2. Re-desglosar base/IVA de todos los precios de los hijos con la nueva
  //    tarifa (sale_price intacto).
  const prices = await manager.find(ProductPrice, {
    where: { product_id: In(childIds), company_id: String(companyId) },
    select: { id: true, sale_price: true },
  });
  for (const price of prices) {
    const { taxableBase, taxAmount } = computeTaxBreakdown(price.sale_price, taxRatePercent);
    await manager.update(
      ProductPrice,
      { id: price.id, company_id: String(companyId) },
      { iva_percentage: taxRatePercent, taxable_base: taxableBase, tax_amount: taxAmount },
    );
  }

  return { updatedChildren: childIds.length, updatedPrices: prices.length };
}
