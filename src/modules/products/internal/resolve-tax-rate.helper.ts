import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { TaxRate } from '@/modules/taxes/entities/tax-rate.entity';
import { Product } from '../entities/product.entity';

/**
 * Resuelve la tarifa PORCENTUAL de IVA a partir de un `tax_rate_id`.
 *
 * El catálogo `tax_rates` es GLOBAL (no lleva company_id), así que se busca por
 * id sin scoping. `null`/`undefined` = sin definir → 0 (Exento). Un id que no
 * existe o está inactivo es un 400: el cliente mandó una referencia inválida.
 *
 * Devuelve solo el porcentaje (number) porque es lo único que el cálculo del
 * desglose base/IVA necesita; la persistencia del `tax_rate_id` la hace la
 * action con el valor del DTO.
 */
export async function resolveTaxRatePercent(
  manager: EntityManager,
  taxRateId: number | null | undefined,
): Promise<number> {
  if (taxRateId === null || taxRateId === undefined) {
    return 0;
  }

  const tax = await manager.findOne(TaxRate, {
    where: { id: String(taxRateId), is_active: true },
  });
  if (!tax) {
    throw new BadRequestException(`La tarifa de IVA ${taxRateId} no existe o está inactiva.`);
  }
  return Number(tax.rate);
}

/**
 * Devuelve el `tax_rate_id` del producto base (para que una presentación herede
 * su configuración fiscal). `null` si el base no tiene tarifa (Exento) o no se
 * encuentra. Multi-tenant: filtra por company.
 */
export async function loadParentTaxRateId(
  manager: EntityManager,
  parentId: number,
  companyId: number,
): Promise<number | null> {
  const parent = await manager.findOne(Product, {
    where: { id: String(parentId), company_id: String(companyId) },
    select: { id: true, tax_rate_id: true },
  });
  return parent?.tax_rate_id != null ? Number(parent.tax_rate_id) : null;
}
