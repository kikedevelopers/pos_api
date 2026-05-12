import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import type { SalesHistoryResponseDto } from '../dto/product-response.dto';

/**
 * Endpoint `GET /inventory/:id/sales-history`.
 *
 * Estado Fase 3: la entidad `SaleInvoiceLine` no existe todavía. Para
 * preservar el contrato HTTP que el cliente PlacePos espera, devolvemos
 * un payload vacío válido (`sales: []`, `summary` en ceros).
 *
 * TODO(Fase 6): cuando exista `sale_invoice_lines`, reemplazar este
 * placeholder con la query SQL real (espejo de PlacePos
 * `inventory.routes.ts` líneas 311-408). Multi-tenant: AGREGAR
 * `AND si.company_id = $companyId` al WHERE.
 *
 * Validación: el producto debe existir y pertenecer a la company
 * (anti-enumeración cross-tenant).
 */
@Injectable()
export class GetProductSalesHistoryAction {
  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
  ) {}

  async execute(productId: number, companyId: number): Promise<SalesHistoryResponseDto> {
    // Pre-validación multi-tenant: el producto debe existir y ser de la
    // company. Sin esto, un id ajeno devolvería 200 con array vacío, lo
    // que sería confuso y enmascararía intentos de enumeración.
    const exists = await this.productRepo.findOne({
      where: { id: String(productId), company_id: String(companyId) },
      select: ['id'],
    });
    if (!exists) {
      throw new NotFoundException('Producto no encontrado.');
    }

    // Placeholder Fase 3 — Fase 6 reemplazará por query real.
    return {
      sales: [],
      summary: {
        timesInvoiced: 0,
        totalQuantity: 0,
        totalSales: 0,
        totalCost: 0,
        totalProfit: 0,
        averageMargin: 0,
      },
    };
  }
}
