import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Customer } from '../entities/customer.entity';
import { findCustomerInCompany } from '../internal/customer-lookups';

/**
 * Archiva / desarchiva un customer (`PATCH /customers/:id/archive`).
 *
 * Setea `is_archived` al valor pedido. Idempotente: aplicar el mismo valor que
 * ya tiene NO falla — el UPDATE corre igual (o se omite si no hay cambio) y se
 * devuelve el row.
 *
 * Tenancy: el WHERE del UPDATE filtra por `(id, company_id)`; la
 * pre-verificación con `findCustomerInCompany` da 404 antes si el cliente no
 * pertenece a la company.
 *
 * Transacción: pre-verificación + UPDATE + re-fetch comparten manager
 * (snapshot isolation), igual que `UpdateCustomerAction`.
 */
@Injectable()
export class ArchiveCustomerAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, isArchived: boolean, companyId: number): Promise<Customer> {
    return this.dataSource.transaction<Customer>(async (manager) => {
      const existing = await findCustomerInCompany(manager, id, companyId);

      // No-op idempotente: si ya está en el valor pedido, evitamos el UPDATE.
      if (existing.is_archived === isArchived) {
        return existing;
      }

      await manager.update(
        Customer,
        { id: String(id), company_id: String(companyId) },
        { is_archived: isArchived },
      );

      return findCustomerInCompany(manager, id, companyId);
    });
  }
}
