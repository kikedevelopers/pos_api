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
  // Ya NETAS de notas: la vista devuelve las líneas de la nota con su signo.
  qty: number;
  sales: number;
  cost: number;
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
    // Una sola consulta contra la vista, que ya trae la venta con sus notas
    // aplicadas. Antes esto eran dos CTE cosidas a mano, y ahí vivían dos
    // defectos medidos en producción:
    //
    //   · la CTE de ventas excluía las anuladas pero la de notas no, así que de
    //     una venta anulada no se sumaban sus líneas pero SÍ se restaba su nota
    //     (NUEZ MOSCADA perdía 90.000 de 117.999,60);
    //   · se agrupaba por (producto, descripción) y las notas cruzaban solo por
    //     producto, así que un artículo renombrado salía dos veces en el ranking
    //     y su nota se restaba en cada fila.
    //
    // La vista cierra los dos de raíz: la línea de la nota vive pegada a su
    // venta, y el producto se identifica por su id. El nombre se resuelve
    // aparte, tomando el más reciente.
    const rows = await this.dataSource.query<AggRow[]>(
      `
      SELECT
        l.product_id::text AS item_id,
        COALESCE(p.name, 'Producto ' || l.product_id) AS name,
        SUM(l.quantity)::float AS qty,
        SUM(l.total)::float AS sales,
        SUM(l.cost)::float AS cost
      FROM v_sale_lines_consolidated l
      LEFT JOIN products p
        ON p.id = l.product_id
       AND p.company_id = $1
      WHERE l.company_id = $1
        AND l.ticket_type = 'SALE'
        AND l.is_deleted = false
      GROUP BY l.product_id, p.name
      `,
      [String(companyId)],
    );

    const items: TopProductItem[] = rows.map((r) => {
      // Ya vienen netas de la vista: las líneas de la nota entran con su signo.
      const netQuantity = toBig(r.qty);
      const netSales = toBig(r.sales);
      const netCost = toBig(r.cost);
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
