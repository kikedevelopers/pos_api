import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Category } from '../entities/category.entity';
import { findCategoryInCompany } from '../internal/category-lookups';

/**
 * Archiva una categoría (`PUT /categories/:id/archive`).
 *
 *   - 404 si no existe o pertenece a otra company.
 *   - 404 si ya está archivada (espejo PlacePos — solo archiva, no des-archiva).
 *   - 200 con `{ archived: true }` al éxito.
 *
 * Productos con `category_id` apuntando a esta categoría NO se modifican —
 * la FK con ON DELETE SET NULL se ejecutaría solo en DELETE físico. El soft-
 * delete deja la asociación intacta para reportes históricos.
 */
@Injectable()
export class ArchiveCategoryAction {
  private readonly logger = new Logger(ArchiveCategoryAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number): Promise<{ archived: true }> {
    await this.dataSource.transaction(async (manager) => {
      const existing = await findCategoryInCompany(manager, id, companyId);

      if (existing.is_archived) {
        throw new NotFoundException('Categoría no encontrada');
      }

      await manager.update(
        Category,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );
    });

    this.logger.log({
      event: 'category.archived',
      companyId,
      categoryId: id,
    });

    return { archived: true };
  }
}
