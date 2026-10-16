import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  type ConsolidatedInvoice,
  getConsolidatedInvoice,
  stripConsolidatedInternalFields,
} from '../internal/consolidate-invoice.helper';
import {
  getSaleCollectionState,
  type SaleCollectionState,
} from '../internal/sale-collection-state';

/**
 * Consolidado + estado de cobro. El POS lo usa al editar: si la venta es un
 * crédito sin abonos (`is_unpaid_credit`) la NC/ND no mueve dinero y NO debe
 * pedir cuenta origen/destino.
 */
export type ConsolidatedInvoiceWithCollection = ConsolidatedInvoice & SaleCollectionState;

/**
 * Espejo PlacePos `getConsolidatedInvoice(invoiceId)` — devuelve la factura
 * con líneas VIVAS tras aplicar todas las NC/ND. Multi-tenant via companyId.
 */
@Injectable()
export class GetConsolidatedInvoiceAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    saleId: number,
    companyId: number,
  ): Promise<ConsolidatedInvoiceWithCollection | null> {
    const manager = this.dataSource.manager;
    const invoice = await getConsolidatedInvoice(manager, companyId, saleId);
    if (!invoice) {
      return null;
    }
    const collection = await getSaleCollectionState(manager, companyId, saleId);
    // FIX #2: el snapshot interno de empaque NUNCA viaja al cliente.
    return { ...stripConsolidatedInternalFields(invoice), ...collection };
  }
}
