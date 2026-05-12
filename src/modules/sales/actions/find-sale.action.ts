import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { SaleCredit } from '../entities/sale-credit.entity';
import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { SaleInvoice } from '../entities/sale-invoice.entity';
import { SalePayment } from '../entities/sale-payment.entity';
import {
  findSaleCredit,
  findSaleInCompany,
  findSaleLines,
  findSalePayments,
} from '../internal/sale-lookups';

/**
 * Agregado completo de una venta (cabecera + líneas + pagos + credit).
 * Espejo PlacePos `getTicketById`.
 */
export interface SaleAggregate {
  sale: SaleInvoice;
  lines: SaleInvoiceLine[];
  payments: SalePayment[];
  credit: SaleCredit | null;
}

/**
 * Lee el detalle completo de una venta por id, dentro de la company.
 *
 * Anti-IDOR: el `findSaleInCompany` exige `company_id = $current`. Si el
 * id existe en otra company → 404 indistinguible de "no existe".
 *
 * N+1 mitigation: cargamos lines / payments / credit en 3 queries dedicadas
 * con índices propios. Total 4 round-trips.
 */
@Injectable()
export class FindSaleAction {
  constructor(
    @InjectRepository(SaleInvoice)
    private readonly repo: Repository<SaleInvoice>,
  ) {}

  async execute(
    id: number,
    companyId: number,
    options: { requireActive?: boolean } = {},
  ): Promise<SaleAggregate> {
    const manager = this.repo.manager;
    const sale = await findSaleInCompany(manager, id, companyId, {
      requireActive: options.requireActive ?? true,
    });
    const lines = await findSaleLines(manager, Number(sale.id), companyId);
    const payments = await findSalePayments(manager, Number(sale.id), companyId);
    const credit = await findSaleCredit(manager, Number(sale.id), companyId);
    return { sale, lines, payments, credit };
  }
}
