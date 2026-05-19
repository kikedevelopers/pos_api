import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import type Big from 'big.js';

import { preciseNumber, toBig } from '@/common/utils/precision';
import type { Packaging } from '@/modules/packagings/entities/packaging.entity';
import type { Product } from '@/modules/products/entities/product.entity';
import type { ProductPrice } from '@/modules/products/entities/product-price.entity';

import type { UpdateSaleLineDto } from '../dto/update-sale.dto';

/**
 * Estructura de cada línea ya calculada y lista para INSERT batch en
 * `sale_invoice_lines`. Coincide byte-por-byte con el shape de la entidad.
 */
export interface ComputedSaleLine {
  company_id: string;
  product_id: string;
  packaging_id: string | null;
  product_price_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  unit_cost: number;
  subtotal: number;
  iva_percentage: number;
  iva_amount: number;
  total: number;
  profit: number;
  margin: number;
}

/**
 * Totales agregados de la venta (cabecera).
 */
export interface ComputedSaleTotals {
  subtotal: number;
  tax_total: number;
  total: number;
  cost: number;
  profit: number;
  margin: number;
  lines: ComputedSaleLine[];
}

/**
 * Calcula los totales de una venta a partir de las líneas validadas y los
 * snapshots de catálogo (product, packaging, product_price). Toda la
 * aritmética usa Big.js — sin floats.
 *
 * Reglas:
 *   - `quantity > 0` (también validado por DTO y CHECK constraint).
 *   - `unit_price >= 0`.
 *   - Si la línea trae `product_price_id`, debe pertenecer al `product_id`.
 *   - El `unit_cost` se toma del `product.cost` actual (snapshot).
 *
 * Cálculo por línea:
 *   subtotal   = unit_price * quantity
 *   iva_amount = subtotal * iva_percentage / 100
 *   total      = subtotal + iva_amount
 *   profit     = (unit_price - unit_cost) * quantity
 *   margin     = profit / total * 100   (0 si total = 0)
 *
 * Cabecera:
 *   subtotal_v  = Σ line.subtotal
 *   tax_total_v = Σ line.iva_amount
 *   total_v     = Σ line.total
 *   cost_v      = Σ line.unit_cost * line.quantity
 *   profit_v    = total_v - cost_v
 *   margin_v    = profit_v / total_v * 100 (0 si total_v = 0)
 */
export function calculateSaleTotals(
  lines: UpdateSaleLineDto[],
  companyId: number,
  productById: Map<number, Product>,
  packagingById: Map<number, Packaging>,
  productPriceById: Map<number, ProductPrice>,
): ComputedSaleTotals {
  let totalSubtotal: Big = toBig(0);
  let totalTax: Big = toBig(0);
  let totalGrand: Big = toBig(0);
  let totalCost: Big = toBig(0);

  const computed: ComputedSaleLine[] = lines.map((line) => {
    const product = productById.get(line.product_id);
    if (!product) {
      throw new BadRequestException('Uno o más productos no existen');
    }

    // Packaging: si la línea trae packaging_id, debe estar en el set válido.
    let packagingId: string | null = null;
    if (typeof line.packaging_id === 'number' && line.packaging_id > 0) {
      const packaging = packagingById.get(line.packaging_id);
      if (!packaging) {
        throw new BadRequestException('Uno o más empaques no existen o están archivados');
      }
      packagingId = String(packaging.id);
    }

    // ProductPrice: si viene, debe pertenecer al product_id de esta línea.
    let productPriceId: string | null = null;
    if (typeof line.product_price_id === 'number' && line.product_price_id > 0) {
      const price = productPriceById.get(line.product_price_id);
      if (!price) {
        throw new BadRequestException('Uno o más niveles de precio no existen');
      }
      if (Number(price.product_id) !== line.product_id) {
        throw new UnprocessableEntityException(
          `El nivel de precio no pertenece al producto ${product.name}`,
        );
      }
      productPriceId = String(price.id);
    }

    const qty = toBig(line.quantity);
    if (qty.lte(0)) {
      // Defensa: el DTO ya rechaza con @IsPositive, pero el CHECK constraint
      // exige > 0. Replicamos aquí para fallar antes del UPDATE.
      throw new UnprocessableEntityException('quantity debe ser mayor a cero');
    }

    const unitPrice = toBig(line.unit_price);
    const unitCost = toBig(product.cost ?? 0);
    const ivaPercentage = toBig(line.iva_percentage ?? 0);

    const subtotal = unitPrice.times(qty);
    const ivaAmount = subtotal.times(ivaPercentage).div(100);
    const lineTotal = subtotal.plus(ivaAmount);
    const lineProfit = unitPrice.minus(unitCost).times(qty);
    const lineCost = unitCost.times(qty);
    const lineMargin = lineTotal.eq(0) ? toBig(0) : lineProfit.div(lineTotal).times(100);

    totalSubtotal = totalSubtotal.plus(subtotal);
    totalTax = totalTax.plus(ivaAmount);
    totalGrand = totalGrand.plus(lineTotal);
    totalCost = totalCost.plus(lineCost);

    return {
      company_id: String(companyId),
      product_id: String(product.id),
      packaging_id: packagingId,
      product_price_id: productPriceId,
      description: line.description?.trim() || product.name,
      quantity: preciseNumber(qty, 4),
      unit_price: preciseNumber(unitPrice, 2),
      unit_cost: preciseNumber(unitCost, 2),
      subtotal: preciseNumber(subtotal, 2),
      iva_percentage: preciseNumber(ivaPercentage, 4),
      iva_amount: preciseNumber(ivaAmount, 2),
      total: preciseNumber(lineTotal, 2),
      profit: preciseNumber(lineProfit, 2),
      margin: preciseNumber(lineMargin, 4),
    };
  });

  if (totalGrand.lte(0)) {
    throw new UnprocessableEntityException('El total de la venta debe ser mayor a cero');
  }

  const totalProfit = totalGrand.minus(totalCost);
  const totalMargin = totalGrand.eq(0) ? toBig(0) : totalProfit.div(totalGrand).times(100);

  return {
    subtotal: preciseNumber(totalSubtotal, 2),
    tax_total: preciseNumber(totalTax, 2),
    total: preciseNumber(totalGrand, 2),
    cost: preciseNumber(totalCost, 2),
    profit: preciseNumber(totalProfit, 2),
    margin: preciseNumber(totalMargin, 4),
    lines: computed,
  };
}
