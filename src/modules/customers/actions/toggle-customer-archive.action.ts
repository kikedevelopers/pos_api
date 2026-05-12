import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Customer } from '../entities/customer.entity';
import { findCustomerInCompany } from '../internal/customer-lookups';

/**
 * Archive toggle (`PUT /customers/:id/archive`).
 *
 * Comportamiento: alterna `is_archived` entre `true` y `false`. Espeja el
 * patrón de `PUT /suppliers/:id/archive` de PlacePos, pero aplicado a
 * customers como extensión cloud (PlacePos local NO archiva customers).
 *
 * No expone un parámetro `archived: boolean`: el frontend lo entiende como
 * toggle puro. Si se necesita un set explícito en el futuro, se agrega un
 * endpoint nuevo sin romper este.
 *
 * Audit log post-commit con el nuevo estado.
 */
@Injectable()
export class ToggleCustomerArchiveAction {
  private readonly logger = new Logger(ToggleCustomerArchiveAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, actorId: number): Promise<Customer> {
    const updated = await this.dataSource.transaction<Customer>(async (manager) => {
      const existing = await findCustomerInCompany(manager, id, companyId);
      const next = !existing.is_archived;

      await manager.update(
        Customer,
        { id: String(id), company_id: String(companyId) },
        { is_archived: next },
      );

      return findCustomerInCompany(manager, id, companyId);
    });

    this.logger.log({
      event: 'customer.archive_toggled',
      actorId,
      customerId: id,
      companyId,
      archived: updated.is_archived,
    });

    return updated;
  }
}
