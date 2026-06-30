import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  type ConsolidatedInvoice,
  getConsolidatedInvoice,
  stripConsolidatedInternalFields,
} from '../internal/consolidate-invoice.helper';

/**
 * Espejo PlacePos `getConsolidatedInvoice(invoiceId)` — devuelve la factura
 * con líneas VIVAS tras aplicar todas las NC/ND. Multi-tenant via companyId.
 */
@Injectable()
export class GetConsolidatedInvoiceAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(saleId: number, companyId: number): Promise<ConsolidatedInvoice | null> {
    const invoice = await getConsolidatedInvoice(this.dataSource.manager, companyId, saleId);
    // FIX #2: el snapshot interno de empaque NUNCA viaja al cliente.
    return invoice ? stripConsolidatedInternalFields(invoice) : null;
  }
}
