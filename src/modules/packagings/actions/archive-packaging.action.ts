import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Packaging } from '../entities/packaging.entity';
import { findPackagingInCompany } from '../internal/packaging-lookups';

/**
 * Archiva un empaque (soft-delete). Endpoint `PUT /packagings/:id/archive`.
 *
 *   - 404 si no existe o pertenece a otra company.
 *   - 404 si ya está archivado (PlacePos: el endpoint solo opera sobre
 *     `is_archived = false`).
 *
 * Defensa en profundidad: `manager.update({ id, company_id }, ...)` con el
 * filtro multi-tenant en el WHERE del UPDATE.
 *
 * Transacción: §8.8 del CLAUDE.md. La pre-validación + el UPDATE viven en
 * la misma transacción. La FK `products.packaging_id` se mantiene válida —
 * archivar NO borra; los productos siguen apuntando al empaque archivado.
 */
@Injectable()
export class ArchivePackagingAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Pre-validar: existe + activo + del mismo tenant.
      await findPackagingInCompany(manager, id, companyId);

      await manager.update(
        Packaging,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );
    });
  }
}
