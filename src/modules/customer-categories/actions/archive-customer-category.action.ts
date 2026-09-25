import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { CustomerCategory } from '../entities/customer-category.entity';
import { findCustomerCategoryInCompany } from '../internal/customer-category-lookups';

/**
 * Archiva una categoría de cliente (`PUT /customer-categories/:id/archive`).
 *
 *   - 404 si no existe o pertenece a otra company.
 *   - 404 si ya está archivada (solo archiva, no des-archiva).
 *   - 200 con `{ archived: true }` al éxito.
 *
 * Clientes con `category_id` apuntando a esta categoría NO se modifican: la FK
 * `ON DELETE SET NULL` solo se dispararía en un DELETE físico. El soft-delete
 * deja la asociación intacta para historial. El filtro por categoría del
 * listado de clientes seguirá encontrándolos por id aunque la categoría esté
 * archivada.
 */
@Injectable()
export class ArchiveCustomerCategoryAction {
  private readonly logger = new Logger(ArchiveCustomerCategoryAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number): Promise<{ archived: true }> {
    await this.dataSource.transaction(async (manager) => {
      const existing = await findCustomerCategoryInCompany(manager, id, companyId);

      if (existing.is_archived) {
        throw new NotFoundException('Categoría de cliente no encontrada');
      }

      await manager.update(
        CustomerCategory,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );
    });

    this.logger.log({
      event: 'customer_category.archived',
      companyId,
      customerCategoryId: id,
    });

    return { archived: true };
  }
}
