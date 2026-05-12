import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import type Big from 'big.js';

import { preciseNumber, toBig } from '@/common/utils/precision';
import type { Packaging } from '@/modules/packagings/entities/packaging.entity';
import type { Product } from '@/modules/products/entities/product.entity';

import type { CreateCreditNoteLineDto } from '../dto/create-credit-note.dto';

/**
 * Estructura de cada línea ya calculada y lista para INSERT batch en
 * `credit_note_lines`. Coincide byte-por-byte con el shape de la entidad.
 */
export interface ComputedCreditNoteLine {
  company_id: string;
  credit_note_id?: string;
  original_line_id: string | null;
  product_id: string;
  packaging_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  unit_cost: number;
  subtotal: number;
  iva_percentage: number;
  iva_amount: number;
  total: number;
}

/**
 * Totales agregados de la nota (cabecera).
 */
export interface ComputedNoteTotals {
  subtotal: number;
  tax_total: number;
  total: number;
  lines: ComputedCreditNoteLine[];
}

/**
 * Calcula los totales de una nota crédito/débito a partir de líneas
 * validadas y snapshots de catálogo. Aritmética Big.js — sin floats.
 *
 * Cálculo por línea:
 *   subtotal   = unit_price * quantity
 *   iva_amount = subtotal * iva_percentage / 100
 *   total      = subtotal + iva_amount
 *
 * Cabecera:
 *   subtotal_v  = Σ line.subtotal
 *   tax_total_v = Σ line.iva_amount
 *   total_v     = Σ line.total
 */
export function calculateNoteTotals(
  lines: CreateCreditNoteLineDto[],
  companyId: number,
  productById: Map<number, Product>,
  packagingById: Map<number, Packaging>,
): ComputedNoteTotals {
  let totalSubtotal: Big = toBig(0);
  let totalTax: Big = toBig(0);
  let totalGrand: Big = toBig(0);

  const computed: ComputedCreditNoteLine[] = lines.map((line) => {
    const product = productById.get(line.product_id);
    if (!product) {
      throw new BadRequestException('Uno o más productos no existen');
    }

    let packagingId: string | null = null;
    if (typeof line.packaging_id === 'number' && line.packaging_id > 0) {
      const packaging = packagingById.get(line.packaging_id);
      if (!packaging) {
        throw new BadRequestException('Uno o más empaques no existen o están archivados');
      }
      packagingId = String(packaging.id);
    }

    const qty = toBig(line.quantity);
    if (qty.lte(0)) {
      throw new UnprocessableEntityException('quantity debe ser mayor a cero');
    }

    const unitPrice = toBig(line.unit_price);
    const unitCost = toBig(product.cost ?? 0);
    const ivaPercentage = toBig(line.iva_percentage ?? 0);

    const subtotal = unitPrice.times(qty);
    const ivaAmount = subtotal.times(ivaPercentage).div(100);
    const lineTotal = subtotal.plus(ivaAmount);

    totalSubtotal = totalSubtotal.plus(subtotal);
    totalTax = totalTax.plus(ivaAmount);
    totalGrand = totalGrand.plus(lineTotal);

    return {
      company_id: String(companyId),
      original_line_id:
        typeof line.original_line_id === 'number' && line.original_line_id > 0
          ? String(line.original_line_id)
          : null,
      product_id: String(product.id),
      packaging_id: packagingId,
      description: line.description?.trim() || product.name,
      quantity: preciseNumber(qty, 4),
      unit_price: preciseNumber(unitPrice, 2),
      unit_cost: preciseNumber(unitCost, 2),
      subtotal: preciseNumber(subtotal, 2),
      iva_percentage: preciseNumber(ivaPercentage, 4),
      iva_amount: preciseNumber(ivaAmount, 2),
      total: preciseNumber(lineTotal, 2),
    };
  });

  if (totalGrand.lte(0)) {
    throw new UnprocessableEntityException('El total de la nota debe ser mayor a cero');
  }

  return {
    subtotal: preciseNumber(totalSubtotal, 2),
    tax_total: preciseNumber(totalTax, 2),
    total: preciseNumber(totalGrand, 2),
    lines: computed,
  };
}
