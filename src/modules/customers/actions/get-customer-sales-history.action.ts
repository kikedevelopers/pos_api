import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Customer } from '@/modules/customers/entities/customer.entity';

import { findCustomerInCompany } from '../internal/customer-lookups';

/**
 * Shape de respuesta del endpoint `GET /customers/:id/sales-history`.
 *
 * Espejo del payload de `placepos/src/main/server/routes/customers.routes.ts`:
 *
 *   {
 *     invoices: [ { id, invoiceNumber, paymentType, isPaid, ... } ],
 *     summary:  { salesCount, totalSales, totalProfit, totalCost, averageMargin }
 *   }
 *
 * En Fase 4 las entidades `SaleInvoice` y `SaleCredit` AÚN no existen. Por eso
 * devolvemos `invoices: []` y `summary` cero. Cuando Fase 6 implemente ventas,
 * esta action se reemplaza con la query SQL real (ver PlacePos para el SQL).
 *
 * TODO(Fase 6): reemplazar con consulta a `sale_invoices` (filtrando
 * customer_id + company_id + is_deleted = false). NO copiar la query de
 * PlacePos sin añadir `company_id` al WHERE — es vulnerabilidad cross-tenant.
 */
export interface CustomerSalesHistoryResponse {
  invoices: unknown[];
  summary: {
    salesCount: number;
    totalSales: number;
    totalProfit: number;
    totalCost: number;
    averageMargin: number;
  };
}

@Injectable()
export class GetCustomerSalesHistoryAction {
  constructor(
    @InjectRepository(Customer)
    private readonly repo: Repository<Customer>,
  ) {}

  async execute(id: number, companyId: number): Promise<CustomerSalesHistoryResponse> {
    // Pre-validar existencia + tenancy. Sin este check, un id de otra company
    // devolvería `{ invoices: [], summary: zeros }` sin distinguirse de un
    // customer vacío — fuga de información cross-tenant.
    await findCustomerInCompany(this.repo.manager, id, companyId);

    return {
      invoices: [],
      summary: {
        salesCount: 0,
        totalSales: 0,
        totalProfit: 0,
        totalCost: 0,
        averageMargin: 0,
      },
    };
  }
}
