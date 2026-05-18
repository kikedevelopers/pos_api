import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Customer } from '@/modules/customers/entities/customer.entity';

/**
 * Shape de respuesta de `GET /customers/analytics`. Espejo PlacePos.
 *
 *   - `customers_count`: total no-archivados.
 *   - `new_customers`: creados en el mes actual (mes del servidor, UTC).
 *   - `evolution`: { month_current, month_previous } — `month_previous` es
 *     el conteo de nuevos del mes anterior; `month_current` espeja
 *     `new_customers`. Esto es lo que el frontend usa para pintar la flecha
 *     ↑/↓ y el porcentaje de variación.
 */
export interface CustomersAnalyticsResponse {
  customers_count: number;
  new_customers: number;
  evolution: {
    month_current: number;
    month_previous: number;
  };
}

/**
 * Calcula analíticas agregadas del módulo customers. Usa `date_trunc('month')`
 * sobre `created_at` para comparar el mes actual con el anterior. El cálculo
 * es robusto a años/meses bisiestos porque PostgreSQL hace la aritmética de
 * fechas con `interval '1 month'`.
 *
 * Multi-tenancy: TODO el conteo se hace contra `company_id`. Sin ese filtro
 * habría fuga cross-tenant.
 *
 * Read puro fuera de transacción. Se hacen 3 queries en paralelo (total, mes
 * actual, mes anterior).
 *
 * NOTE: usamos `query` raw para los conteos por mes — el queryBuilder no
 * soporta `date_trunc` cómodamente sin reescribir el FROM completo.
 */
@Injectable()
export class GetCustomersAnalyticsAction {
  constructor(
    @InjectRepository(Customer)
    private readonly repo: Repository<Customer>,
  ) {}

  async execute(companyId: number): Promise<CustomersAnalyticsResponse> {
    const cidParam = String(companyId);

    const [totalRow, currentRow, previousRow] = await Promise.all([
      this.repo.query(
        `SELECT COUNT(*)::bigint AS total
           FROM customers
          WHERE company_id = $1
            AND is_archived = false`,
        [cidParam],
      ),
      this.repo.query(
        `SELECT COUNT(*)::bigint AS total
           FROM customers
          WHERE company_id = $1
            AND is_archived = false
            AND date_trunc('month', created_at AT TIME ZONE 'UTC')
                = date_trunc('month', now() AT TIME ZONE 'UTC')`,
        [cidParam],
      ),
      this.repo.query(
        `SELECT COUNT(*)::bigint AS total
           FROM customers
          WHERE company_id = $1
            AND is_archived = false
            AND date_trunc('month', created_at AT TIME ZONE 'UTC')
                = date_trunc('month', (now() AT TIME ZONE 'UTC') - interval '1 month')`,
        [cidParam],
      ),
    ]);

    const customers_count = Number(totalRow[0]?.total ?? 0);
    const month_current = Number(currentRow[0]?.total ?? 0);
    const month_previous = Number(previousRow[0]?.total ?? 0);

    return {
      customers_count,
      new_customers: month_current,
      evolution: {
        month_current,
        month_previous,
      },
    };
  }
}

/**
 * Helper exportado por si otro reporte necesita la misma fórmula de
 * "porcentaje de variación entre dos contadores". El cliente Electron NO
 * necesita esto (PlacePos lo calcula en el frontend), pero queda disponible.
 *
 * Si `previous = 0` y `current > 0` → 100 (crecimiento desde cero).
 * Si `previous = 0` y `current = 0` → 0.
 * Si `previous > 0` → `((current - previous) / previous) * 100`.
 */
export function computeEvolutionPercent(current: number, previous: number): number {
  if (previous === 0) {
    return current === 0 ? 0 : 100;
  }
  const c = toBig(current);
  const p = toBig(previous);
  return preciseNumber(c.minus(p).div(p).times(100), 2);
}
