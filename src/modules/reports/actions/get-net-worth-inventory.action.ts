import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { preciseNumber } from '@/common/utils/precision';

export interface NetWorthInventoryItem {
  id: number;
  name: string;
  stock: number;
  cost: number;
  value: number;
}

const round2 = (n: unknown): number => preciseNumber(n, 2);
const round4 = (n: unknown): number => preciseNumber(n, 4);

/**
 * Detalle del INVENTARIO A COSTO para el modal del Informe Patrimonial. Solo
 * productos base (`parent_id IS NULL`) no archivados con stock > 0, ordenados
 * por valor descendente. Se sirve aparte (lazy) del informe principal porque
 * puede ser una lista larga.
 */
@Injectable()
export class GetNetWorthInventoryAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<NetWorthInventoryItem[]> {
    // `stock` mostrado = stock_display (en empaques base) = round(stock /
    // packaging_value, 4); `cost` es por empaque base; `value = cost ×
    // stock_display`. Misma fórmula que el total del informe y que el "Costo
    // total" del modo auditor.
    const rows = (await this.dataSource.query(
      `SELECT p.id::int AS id,
              p.name,
              round(p.stock / COALESCE(NULLIF(pk.value, 0), 1), 4)::float AS stock,
              p.cost::float AS cost,
              (p.cost * round(p.stock / COALESCE(NULLIF(pk.value, 0), 1), 4))::float AS value
         FROM products p
         LEFT JOIN packagings pk ON pk.id = p.packaging_id
        WHERE p.company_id = $1
          AND p.is_archived = false
          AND p.parent_id IS NULL
          AND p.product_type <> 'COMBO'
          AND round(p.stock / COALESCE(NULLIF(pk.value, 0), 1), 4) > 0
        ORDER BY value DESC, p.name ASC`,
      [String(companyId)],
    )) as Array<{ id: number; name: string; stock: number; cost: number; value: number }>;

    return rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      stock: round4(r.stock),
      cost: round2(r.cost),
      value: round2(r.value),
    }));
  }
}
