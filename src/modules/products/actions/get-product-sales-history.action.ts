import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Product } from '@/modules/products/entities/product.entity';

import type { SalesHistoryResponseDto } from '../dto/product-response.dto';

interface SaleLineRow {
  line_id: string;
  invoice_id: string;
  ticket_number: string;
  sale_number: string | null;
  customer_name: string | null;
  quantity: number;
  price: number;
  cost: number;
  total: number;
  profit: number;
  margin: number;
  invoice_date: Date;
}

/**
 * Endpoint `GET /inventory/:id/sales-history`.
 *
 * Historial de ventas de un producto (todas las líneas de venta donde aparece).
 * Espejo de PlacePos `inventory.routes.ts` (`GET /:id/sales-history`), con
 * filtro multi-tenant por `company_id`.
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
    const exists = await this.productRepo.findOne({
      where: { id: String(productId), company_id: String(companyId) },
      select: ['id'],
    });
    if (!exists) {
      throw new NotFoundException('Producto no encontrado.');
    }

    const rows = await this.productRepo.manager.query<SaleLineRow[]>(
      `
      SELECT
        sil.id                  AS line_id,
        sil.sale_invoice_id     AS invoice_id,
        si.ticket_number,
        si.sale_number,
        si.customer_name,
        sil.quantity::float8    AS quantity,
        sil.unit_price::float8  AS price,
        sil.unit_cost::float8   AS cost,
        sil.total::float8       AS total,
        sil.profit::float8      AS profit,
        sil.margin::float8      AS margin,
        si.created_at           AS invoice_date
      FROM sale_invoice_lines sil
      INNER JOIN sale_invoices si ON si.id = sil.sale_invoice_id
      WHERE sil.product_id = $1
        AND sil.company_id = $2
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
      ORDER BY si.created_at DESC
      `,
      [String(productId), String(companyId)],
    );

    let totalQuantity = toBig(0);
    let totalSales = toBig(0);
    let totalCost = toBig(0);
    let totalProfit = toBig(0);

    for (const r of rows) {
      const qty = toBig(r.quantity);
      totalQuantity = totalQuantity.plus(qty);
      totalSales = totalSales.plus(toBig(r.total));
      totalCost = totalCost.plus(toBig(r.cost).times(qty));
      totalProfit = totalProfit.plus(toBig(r.profit));
    }

    const totalSalesNum = preciseNumber(totalSales, 2);
    const totalProfitNum = preciseNumber(totalProfit, 2);
    const averageMargin =
      totalSalesNum > 0
        ? preciseNumber(toBig(totalProfitNum).div(totalSalesNum).times(100), 2)
        : 0;

    return {
      sales: rows.map((r) => ({
        lineId: Number(r.line_id),
        invoiceId: Number(r.invoice_id),
        ticketNumber: r.ticket_number,
        saleNumber: r.sale_number,
        customerName: r.customer_name || 'CONSUMIDOR FINAL',
        quantity: Number(r.quantity),
        price: Number(r.price),
        total: Number(r.total),
        profit: Number(r.profit),
        margin: Number(r.margin),
        invoiceDate: new Date(r.invoice_date).toISOString(),
      })),
      summary: {
        timesInvoiced: rows.length,
        totalQuantity: preciseNumber(totalQuantity, 4),
        totalSales: totalSalesNum,
        totalCost: preciseNumber(totalCost, 2),
        totalProfit: totalProfitNum,
        averageMargin,
      },
    };
  }
}
