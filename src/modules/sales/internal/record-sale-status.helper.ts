import type { EntityManager } from 'typeorm';

import {
  SaleStatusEventType,
  SaleStatusHistory,
} from '../entities/sale-status-history.entity';

/**
 * Parámetros para registrar una transición de estado de una venta.
 */
export interface RecordSaleStatusParams {
  companyId: number;
  saleInvoiceId: number;
  eventType: SaleStatusEventType;
  /** Monto asociado (cobro/abono/total del crédito). Omitir → NULL. */
  amount?: number | null;
  /** Snapshot del nombre del actor. Omitir → NULL. */
  createdBy?: string | null;
}

/**
 * Inserta UNA fila en `sale_status_history` dentro de la transacción activa.
 *
 * Helper compartido por todos los flujos de venta (crear, cobrar, abrir
 * crédito, abonar, anular) para no duplicar el INSERT ni divergir en el shape.
 * NO abre transacción propia: recibe el `manager` de la TX en curso para que el
 * evento sea atómico con la mutación de negocio que lo origina (si la operación
 * hace rollback, el evento también).
 *
 * `created_at` lo asigna `@CreateDateColumn` / el default `now()` de la columna
 * — el orden de inserción dentro de una misma TX queda reflejado además por el
 * `id` autoincremental, que el serializador usa como desempate estable.
 */
export async function recordSaleStatus(
  manager: EntityManager,
  params: RecordSaleStatusParams,
): Promise<void> {
  await manager.insert(SaleStatusHistory, {
    company_id: String(params.companyId),
    sale_invoice_id: String(params.saleInvoiceId),
    event_type: params.eventType,
    amount: params.amount ?? null,
    created_by: params.createdBy ?? null,
  });
}
