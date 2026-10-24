import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { PurchaseLine } from '../entities/purchase-line.entity';

/** Último costo BRUTO de compra de un producto (antes de flete, sin IVA). */
export interface LastPurchaseCost {
  product_id: number;
  purchase_id: number;
  /** Costo por empaque tal como lo facturó el proveedor en esa línea. */
  packaging_price: number;
  /** Valor del empaque de ESA línea en unidad mínima (null = sin empaque). */
  packaging_value: number | null;
  /** Costo por unidad mínima de esa línea (packaging_price / packaging_value). */
  unit_price: number;
  purchase_created_at: string;
}

interface LastPurchaseCostRow {
  product_id: string;
  purchase_id: string;
  packaging_price: string | number;
  packaging_value: string | number | null;
  unit_price: string | number;
  purchase_created_at: Date;
}

/**
 * `GET /purchases/last-costs` — Por cada producto de la company, el costo de
 * la ÚLTIMA línea de compra en que apareció, tal como la facturó el proveedor.
 *
 * Por qué existe: `products.cost` es el costo ponderado CON el flete
 * prorrateado (ver `recalculate-product-costs.helper.ts`). Sugerirlo como
 * costo de una compra nueva infla la factura (el flete se volvería a sumar
 * encima y el proveedor cobraría de más sin que nadie lo note). El
 * configurador de compras usa este costo bruto como sugerencia.
 *
 * Reglas:
 *   - Solo compras no eliminadas (`is_deleted = false`), PENDING o RECEIVED.
 *   - La "última" es la compra más reciente (`purchases.created_at`); dentro
 *     de una misma compra con el producto repetido, la línea de mayor id.
 *   - Se ignoran líneas con `packaging_price <= 0` (bonificaciones/regalos):
 *     sugerir $0 sería peor que sugerir el costo anterior.
 *
 * Multi-tenant: `company_id` en `purchase_lines` y en `purchases`.
 * Read puro — no requiere transacción.
 */
@Injectable()
export class FindLastPurchaseCostsAction {
  constructor(
    @InjectRepository(PurchaseLine)
    private readonly lineRepo: Repository<PurchaseLine>,
  ) {}

  async execute(companyId: number): Promise<LastPurchaseCost[]> {
    const rows = await this.lineRepo.manager.query<LastPurchaseCostRow[]>(
      `
      SELECT DISTINCT ON (pl.product_id)
        pl.product_id,
        pl.purchase_id,
        pl.packaging_price,
        pl.packaging_value,
        pl.unit_price,
        p.created_at AS purchase_created_at
      FROM purchase_lines pl
      INNER JOIN purchases p ON p.id = pl.purchase_id
      WHERE pl.company_id = $1
        AND p.company_id = $1
        AND p.is_deleted = false
        AND pl.product_id IS NOT NULL
        AND pl.packaging_price > 0
      ORDER BY pl.product_id, p.created_at DESC, p.id DESC, pl.id DESC
      `,
      [String(companyId)],
    );

    return rows.map((r) => ({
      product_id: Number(r.product_id),
      purchase_id: Number(r.purchase_id),
      packaging_price: Number(r.packaging_price),
      packaging_value: r.packaging_value === null ? null : Number(r.packaging_value),
      unit_price: Number(r.unit_price),
      purchase_created_at: r.purchase_created_at.toISOString(),
    }));
  }
}
