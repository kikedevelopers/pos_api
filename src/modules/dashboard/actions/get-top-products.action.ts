import { Injectable } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

/**
 * Item del top consolidado. Cada métrica es NET: ventas brutas menos CN
 * (devoluciones) más ND (cargos adicionales).
 */
export interface TopProductItem {
  itemId: number;
  name: string;
  quantitySold: number;
  totalSales: number;
  totalCost: number;
  totalProfit: number;
  avgMargin: number;
}

interface AggRow {
  item_id: string;
  name: string;
  qty: number;
  sales: number;
  cost: number;
  c_qty: number;
  c_sales: number;
  c_cost: number;
  d_qty: number;
  d_sales: number;
  d_cost: number;
}

/**
 * `GET /dashboard/top-products?limit=N`.
 *
 * Espejo PlacePos: consolida cantidades vendidas, ventas, costo, ganancia y
 * margen por producto, restando las CN (devoluciones) y sumando las ND
 * (cargos). Ordena DESC por unidades netas vendidas.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * Filtro `il.company_id = $1` Y `si.company_id = $1` en sale_invoices, Y
 * `cnl.company_id = $1` Y `cn.company_id = $1` en notas. Cuatro filtros, uno
 * por cada tabla involucrada — defensa en profundidad.
 *
 * --------------------------------------------------------------------------
 * Performance
 * --------------------------------------------------------------------------
 *
 * PlacePos hace `find` en JS con .map; nosotros agregamos en SQL para evitar
 * traer todas las líneas a memoria. Una sola query, sin N+1.
 *
 * Índices asumidos:
 *   - `idx_sale_invoices_company_active_created` (cubre filtro + join).
 *   - `sale_invoice_lines.sale_invoice_id` (FK auto-indexed por Postgres? No
 *     siempre — TODO Fase 11.5: validar `CREATE INDEX
 *     idx_sale_invoice_lines_sale_invoice_id`).
 *   - `credit_note_lines.credit_note_id` ídem.
 *   - `credit_notes.sale_invoice_id` ídem.
 */
@Injectable()
export class GetTopProductsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, limit = 10): Promise<TopProductItem[]> {
    const rows = await this.dataSource.query<AggRow[]>(
      `
      WITH sale_lines AS (
        SELECT
          il.product_id AS item_id,
          il.description AS name,
          SUM(il.quantity)::float AS qty,
          SUM(il.total)::float AS sales,
          SUM(il.unit_cost * il.quantity)::float AS cost
        FROM sale_invoice_lines il
        INNER JOIN sale_invoices si
          ON si.id = il.sale_invoice_id
         AND si.company_id = $1
        WHERE il.company_id = $1
          AND si.ticket_type = 'SALE'
          AND si.is_deleted = false
        GROUP BY il.product_id, il.description
      ),
      note_lines AS (
        SELECT
          cnl.product_id AS item_id,
          cn.note_type::text AS note_type,
          SUM(cnl.quantity)::float AS qty,
          SUM(cnl.total)::float AS sales,
          SUM(cnl.unit_cost * cnl.quantity)::float AS cost
        FROM credit_note_lines cnl
        INNER JOIN credit_notes cn
          ON cn.id = cnl.credit_note_id
         AND cn.company_id = $1
        INNER JOIN sale_invoices si
          ON si.id = cn.sale_invoice_id
         AND si.company_id = $1
        WHERE cnl.company_id = $1
          AND cn.is_deleted = false
          AND si.ticket_type = 'SALE'
        GROUP BY cnl.product_id, cn.note_type
      )
      SELECT
        sl.item_id::text AS item_id,
        sl.name AS name,
        COALESCE(sl.qty, 0)::float AS qty,
        COALESCE(sl.sales, 0)::float AS sales,
        COALESCE(sl.cost, 0)::float AS cost,
        COALESCE((SELECT qty FROM note_lines nl WHERE nl.item_id = sl.item_id AND nl.note_type = 'CREDIT'), 0)::float AS c_qty,
        COALESCE((SELECT sales FROM note_lines nl WHERE nl.item_id = sl.item_id AND nl.note_type = 'CREDIT'), 0)::float AS c_sales,
        COALESCE((SELECT cost  FROM note_lines nl WHERE nl.item_id = sl.item_id AND nl.note_type = 'CREDIT'), 0)::float AS c_cost,
        COALESCE((SELECT qty FROM note_lines nl WHERE nl.item_id = sl.item_id AND nl.note_type = 'DEBIT'), 0)::float AS d_qty,
        COALESCE((SELECT sales FROM note_lines nl WHERE nl.item_id = sl.item_id AND nl.note_type = 'DEBIT'), 0)::float AS d_sales,
        COALESCE((SELECT cost  FROM note_lines nl WHERE nl.item_id = sl.item_id AND nl.note_type = 'DEBIT'), 0)::float AS d_cost
      FROM sale_lines sl
      `,
      [String(companyId)],
    );

    const items: TopProductItem[] = rows.map((r) => {
      const qty = toBig(r.qty);
      const sales = toBig(r.sales);
      const cost = toBig(r.cost);
      const cQty = toBig(r.c_qty);
      const cSales = toBig(r.c_sales);
      const cCost = toBig(r.c_cost);
      const dQty = toBig(r.d_qty);
      const dSales = toBig(r.d_sales);
      const dCost = toBig(r.d_cost);

      const netQuantity = qty.minus(cQty).plus(dQty);
      const netSales = sales.minus(cSales).plus(dSales);
      const netCost = cost.minus(cCost).plus(dCost);
      const netProfit = netSales.minus(netCost);
      const netMargin = netSales.gt(0) ? netProfit.div(netSales).times(100) : new Big(0);

      return {
        itemId: Number(r.item_id),
        name: r.name,
        quantitySold: Math.round(netQuantity.toNumber()),
        totalSales: Number(netSales.round(2).toString()),
        totalCost: Number(netCost.round(2).toString()),
        totalProfit: Number(netProfit.round(2).toString()),
        avgMargin: Number(netMargin.round(2).toString()),
      };
    });

    items.sort((a, b) => b.quantitySold - a.quantitySold);
    return items.slice(0, limit);
  }
}
