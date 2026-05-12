import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { SaleCredit } from '../entities/sale-credit.entity';
import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { SaleInvoice } from '../entities/sale-invoice.entity';
import { SalePayment } from '../entities/sale-payment.entity';

/**
 * Helpers internos del módulo `sales`. Centralizan la lectura del agregado
 * (sale + lines + payments + credit) dentro de la company.
 *
 * Diseño espejo de `purchases/internal/purchase-lookups.ts`.
 */

/**
 * Lookup por id dentro de una company. `options.requireActive = true` filtra
 * `is_deleted = false` (default true para reads públicos; las mutaciones
 * pueden saltar el filtro si necesitan tocar ventas soft-deleted).
 */
export async function findSaleInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
  options: { requireActive?: boolean; lock?: boolean } = {},
): Promise<SaleInvoice> {
  const where: { id: string; company_id: string; is_deleted?: boolean } = {
    id: String(id),
    company_id: String(companyId),
  };
  if (options.requireActive !== false) {
    where.is_deleted = false;
  }

  const sale = await manager.findOne(SaleInvoice, {
    where,
    ...(options.lock === true ? { lock: { mode: 'pessimistic_write' as const } } : {}),
  });
  if (!sale) {
    throw new NotFoundException('Venta no encontrada');
  }
  return sale;
}

export async function findSaleLines(
  manager: EntityManager,
  saleId: number,
  companyId: number,
): Promise<SaleInvoiceLine[]> {
  return manager.find(SaleInvoiceLine, {
    where: { sale_invoice_id: String(saleId), company_id: String(companyId) },
    order: { id: 'ASC' },
  });
}

export async function findSalePayments(
  manager: EntityManager,
  saleId: number,
  companyId: number,
): Promise<SalePayment[]> {
  return manager.find(SalePayment, {
    where: { sale_invoice_id: String(saleId), company_id: String(companyId) },
    order: { created_at: 'ASC' },
  });
}

export async function findSaleCredit(
  manager: EntityManager,
  saleId: number,
  companyId: number,
  options: { lock?: boolean } = {},
): Promise<SaleCredit | null> {
  return manager.findOne(SaleCredit, {
    where: { sale_invoice_id: String(saleId), company_id: String(companyId) },
    ...(options.lock === true ? { lock: { mode: 'pessimistic_write' as const } } : {}),
  });
}
