import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Customer } from '@/modules/customers/entities/customer.entity';

import { findCustomerInCompany } from '../internal/customer-lookups';

/**
 * Endpoints `GET /customers/:id/sales-chart` y `GET /customers/:id/product-history`.
 *
 * En PlacePos local viven en dos rutas distintas, pero la lógica de "datos
 * analíticos del cliente" es la misma familia. Mantenemos rutas separadas en
 * el controller (paridad byte-por-byte) y dejamos esta action como entrada
 * placeholder para ambas: pre-valida tenancy + retorna `{ startDate, endDate,
 * points: [] }` o `{ lines: [] }` respectivamente.
 *
 * TODO(Fase 6): reemplazar con queries reales sobre `sale_invoices`,
 * `sale_invoice_lines` y `credit_notes`. Reproducir la CTE `consolidated` de
 * PlacePos (que aplica ND/NC al total y al cost) AÑADIENDO el filtro
 * `company_id` al WHERE — sin él, un cliente podría leer ventas de otra
 * company que comparta el mismo customer_id (escenario imposible hoy por las
 * FKs, pero la defensa en profundidad evita regresiones futuras).
 */
export interface CustomerSalesChartResponse {
  startDate: string;
  endDate: string;
  points: { date: string; total: number; profit: number; margin: number }[];
}

export interface CustomerProductHistoryResponse {
  lines: {
    productName: string;
    quantity: number;
    price: number;
    profit: number;
    margin: number;
    ticketNumber: string;
  }[];
}

/**
 * Parsea/normaliza el rango de fechas que PlacePos acepta como query string:
 *
 *   - `startDate` y `endDate` opcionales en formato YYYY-MM-DD.
 *   - Sin `endDate`: hoy.
 *   - Sin `startDate`: endDate - 30 días.
 *   - Si `startDate > endDate`: 400.
 *
 * Devuelve siempre strings (no Date) para que la SQL futura los pueda
 * inyectar como parámetros sin reformatear.
 */
function parseChartRange(
  startDate?: string,
  endDate?: string,
): { startDate: string; endDate: string } {
  const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

  if (startDate !== undefined && !DATE_REGEX.test(startDate)) {
    throw new BadRequestException('Rango de fechas inválido');
  }
  if (endDate !== undefined && !DATE_REGEX.test(endDate)) {
    throw new BadRequestException('Rango de fechas inválido');
  }

  const now = new Date();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const resolvedEnd = endDate ?? todayLocal;

  let resolvedStart: string;
  if (startDate) {
    resolvedStart = startDate;
  } else {
    const base = new Date(`${resolvedEnd}T00:00:00`);
    base.setDate(base.getDate() - 30);
    resolvedStart = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  }

  if (resolvedStart > resolvedEnd) {
    throw new BadRequestException('Rango de fechas inválido');
  }

  return { startDate: resolvedStart, endDate: resolvedEnd };
}

@Injectable()
export class GetCustomerChartsAction {
  constructor(
    @InjectRepository(Customer)
    private readonly repo: Repository<Customer>,
  ) {}

  async getSalesChart(
    id: number,
    companyId: number,
    startDate?: string,
    endDate?: string,
  ): Promise<CustomerSalesChartResponse> {
    await findCustomerInCompany(this.repo.manager, id, companyId);
    const range = parseChartRange(startDate, endDate);

    return {
      startDate: range.startDate,
      endDate: range.endDate,
      points: [],
    };
  }

  async getProductHistory(id: number, companyId: number): Promise<CustomerProductHistoryResponse> {
    await findCustomerInCompany(this.repo.manager, id, companyId);

    return {
      lines: [],
    };
  }
}
