import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Product } from '../entities/product.entity';
import type { SupplierHistoryResponseDto } from '../dto/supplier-history-response.dto';

interface SupplierHistoryRow {
  purchase_id: string | number;
  purchase_number: string;
  invoice_date: Date;
  packaging_qty: string | number;
  unit_qty: string | number;
  unit_price: string | number;
  packaging_price: string | number;
  total: string | number;
  packaging_name: string | null;
}

/**
 * `GET /inventory/:productId/supplier-history/:supplierId` — Últimas 10
 * compras del producto al proveedor (espejo PlacePos línea 473-561).
 *
 * Resolución parent_id:
 *   - Si el producto solicitado es una presentación (`parent_id != null`),
 *     consulta el historial usando el id del padre. Las `purchase_lines`
 *     no se registran contra presentaciones — viven en el producto base.
 *   - Si es un producto raíz, usa su propio id.
 *
 * Multi-tenant:
 *   - Filtro `p.company_id = $companyId` en TODA la query (purchase +
 *     purchase_lines + product).
 *   - 404 (mensaje genérico) si el producto no existe en la company.
 *
 * Notas paridad PlacePos:
 *   - PlacePos usa `p.invoice_date` y `p.invoice_number`. En pos_api esos
 *     campos no existen aún: usamos `purchases.created_at` para
 *     `invoice_date` y omitimos `invoice_number`. El shape `purchase_status`
 *     y `purchase_total` también se omiten — el cliente actual no los
 *     consume en este endpoint.
 *   - LIMIT 10 — mismo número.
 *
 * Read puro → no requiere transacción.
 */
@Injectable()
export class FindSupplierHistoryAction {
  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
  ) {}

  async execute(
    productId: number,
    supplierId: number,
    companyId: number,
  ): Promise<SupplierHistoryResponseDto> {
    // Pre-validación multi-tenant: el producto debe existir en la company.
    const requested = await this.productRepo.findOne({
      where: { id: String(productId), company_id: String(companyId) },
      select: { id: true, parent_id: true },
    });
    if (!requested) {
      throw new NotFoundException('Producto no encontrado.');
    }

    const resolvedToParent = requested.parent_id !== null && requested.parent_id !== undefined;
    const targetId = resolvedToParent ? Number(requested.parent_id) : productId;

    // Query SQL raw (paridad PlacePos). El JOIN con `purchases` es necesario
    // para ordenar por `created_at` y filtrar `is_deleted = false`.
    // `company_id` se filtra DOBLE — defensa en profundidad contra cualquier
    // futura corrupción de `purchase_lines.company_id` vs `purchases.company_id`.
    const rows = await this.productRepo.manager.query<SupplierHistoryRow[]>(
      `
      SELECT
        pl.purchase_id,
        p.purchase_number,
        p.created_at        AS invoice_date,
        pl.packaging_qty,
        pl.unit_qty,
        pl.unit_price,
        pl.packaging_price,
        pl.total,
        pl.packaging_name
      FROM purchase_lines pl
      INNER JOIN purchases p ON p.id = pl.purchase_id
      WHERE pl.product_id = $1
        AND pl.supplier_id = $2
        AND pl.company_id = $3
        AND p.company_id = $3
        AND p.is_deleted = false
      ORDER BY p.created_at DESC
      LIMIT 10
      `,
      [targetId, supplierId, companyId],
    );

    return {
      product_id: productId,
      resolved_to_parent: resolvedToParent,
      supplier_id: supplierId,
      lines: rows.map((r) => ({
        purchase_id: Number(r.purchase_id),
        purchase_number: r.purchase_number,
        invoice_date: r.invoice_date.toISOString(),
        packaging_qty: Number(r.packaging_qty),
        unit_qty: Number(r.unit_qty),
        unit_price: Number(r.unit_price),
        packaging_price: Number(r.packaging_price),
        total: Number(r.total),
        packaging_name: r.packaging_name,
      })),
    };
  }
}
