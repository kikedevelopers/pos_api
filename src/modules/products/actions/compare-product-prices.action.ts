import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Product } from '../entities/product.entity';
import type { PriceComparisonResponseDto } from '../dto/price-comparison-response.dto';

interface PriceComparisonRow {
  supplier_id: string | number;
  supplier_name: string;
  last_purchase_id: string | number;
  last_purchase_date: Date;
  packaging_price: string | number;
  unit_price: string | number;
}

/**
 * `GET /inventory/:id/price-comparison` — Para un producto, devuelve el
 * ÚLTIMO precio de compra por cada proveedor que lo haya provisto.
 * Espejo PlacePos línea 568-668.
 *
 * Resolución parent_id:
 *   - Si el producto es presentación (`parent_id != null`), busca el
 *     historial con el id del padre — las purchase_lines viven en el
 *     producto base.
 *   - `resolved_to_parent` indica si esto ocurrió. El payload `product`
 *     siempre describe el producto EFECTIVAMENTE consultado (el padre si
 *     hubo resolución).
 *
 * Multi-tenant:
 *   - Filtro `company_id` en el lookup inicial y en la query SQL.
 *   - 404 con mensaje genérico anti-enumeración cross-tenant.
 *
 * SQL: `DISTINCT ON (supplier_id)` + `ORDER BY supplier_id, created_at DESC`
 * para obtener la última compra por proveedor. Equivalente al patrón
 * `WINDOW + ROW_NUMBER` pero usando la extensión idiomática de Postgres.
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class CompareProductPricesAction {
  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
  ) {}

  async execute(
    requestedProductId: number,
    companyId: number,
  ): Promise<PriceComparisonResponseDto> {
    // Pre-validación multi-tenant: el producto debe existir en la company.
    // Cargamos packaging para devolver el descriptor en el payload.
    const requested = await this.productRepo.findOne({
      where: { id: String(requestedProductId), company_id: String(companyId) },
      relations: { packaging: true },
    });
    if (!requested) {
      throw new NotFoundException('Producto no encontrado.');
    }

    const resolvedToParent = requested.parent_id !== null && requested.parent_id !== undefined;
    let target: Product = requested;
    if (resolvedToParent) {
      const parent = await this.productRepo.findOne({
        where: { id: String(requested.parent_id), company_id: String(companyId) },
        relations: { packaging: true },
      });
      if (!parent) {
        // Edge case raro: presentación huérfana. Mejor reportar que devolver
        // payload corrupto.
        throw new NotFoundException('Producto padre no encontrado.');
      }
      target = parent;
    }

    const targetId = Number(target.id);

    // DISTINCT ON garantiza una fila por supplier (la más reciente).
    // company_id se enforza tanto en `purchase_lines` como en `purchases`
    // como defensa en profundidad.
    const rows = await this.productRepo.manager.query<PriceComparisonRow[]>(
      `
      SELECT DISTINCT ON (pl.supplier_id)
        pl.supplier_id,
        s.legal_name             AS supplier_name,
        pl.purchase_id           AS last_purchase_id,
        p.created_at             AS last_purchase_date,
        pl.packaging_price,
        pl.unit_price
      FROM purchase_lines pl
      INNER JOIN purchases p ON p.id = pl.purchase_id
      INNER JOIN suppliers s ON s.id = pl.supplier_id
      WHERE pl.product_id = $1
        AND pl.company_id = $2
        AND p.company_id = $2
        AND s.company_id = $2
        AND p.is_deleted = false
      ORDER BY pl.supplier_id, p.created_at DESC
      `,
      [targetId, companyId],
    );

    return {
      product: {
        id: Number(target.id),
        name: target.name,
        sku_code: target.sku_code,
        packaging: target.packaging
          ? {
              id: Number(target.packaging.id),
              name: target.packaging.name,
              value: Number(target.packaging.value),
            }
          : null,
      },
      requested_product_id: requestedProductId,
      resolved_to_parent: resolvedToParent,
      suppliers: rows.map((r) => ({
        supplier_id: Number(r.supplier_id),
        supplier_name: r.supplier_name,
        last_purchase_id: Number(r.last_purchase_id),
        last_purchase_date: r.last_purchase_date.toISOString(),
        packaging_price: Number(r.packaging_price),
        unit_price: Number(r.unit_price),
      })),
    };
  }
}
