import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { SalePayment } from '../entities/sale-payment.entity';
import { findSaleInCompany, findSalePayments } from '../internal/sale-lookups';

/**
 * Lista pagos de una venta. Validación previa: la venta debe existir en la
 * company (anti-IDOR). El listado se ordena por `created_at ASC` para
 * mostrar historial cronológico.
 */
@Injectable()
export class ListSalePaymentsAction {
  constructor(
    @InjectRepository(SalePayment)
    private readonly repo: Repository<SalePayment>,
  ) {}

  async execute(saleId: number, companyId: number): Promise<SalePayment[]> {
    const manager = this.repo.manager;
    await findSaleInCompany(manager, saleId, companyId, { requireActive: true });
    return findSalePayments(manager, saleId, companyId);
  }
}
