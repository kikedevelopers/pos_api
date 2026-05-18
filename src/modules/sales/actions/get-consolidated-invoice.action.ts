import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  type ConsolidatedInvoice,
  getConsolidatedInvoice,
} from '../internal/consolidate-invoice.helper';

/**
 * Espejo PlacePos `getConsolidatedInvoice(invoiceId)` — devuelve la factura
 * con líneas VIVAS tras aplicar todas las NC/ND. Multi-tenant via companyId.
 */
@Injectable()
export class GetConsolidatedInvoiceAction {
  constructor(private readonly dataSource: DataSource) {}

  execute(saleId: number, companyId: number): Promise<ConsolidatedInvoice | null> {
    return getConsolidatedInvoice(this.dataSource.manager, companyId, saleId);
  }
}
