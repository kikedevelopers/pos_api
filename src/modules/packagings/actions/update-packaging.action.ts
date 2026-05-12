import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdatePackagingDto } from '../dto/update-packaging.dto';
import { Packaging } from '../entities/packaging.entity';
import { translatePackagingConstraintError } from '../internal/constraint-errors';
import { findPackagingInCompany } from '../internal/packaging-lookups';

/**
 * Actualiza un empaque activo de la company autenticada.
 *
 *   - 404 si no existe o pertenece a otra company (anti-enumeración).
 *   - 404 si `is_archived = true` (PlacePos también lo trata como ausente).
 *   - Colisión por `(company_id, lower(name))` → 409 con
 *     `code: PACKAGING_NAME_TAKEN`.
 *
 * Defensa en profundidad: `manager.update({ id, company_id }, patch)` para
 * que el filtro multi-tenant esté en el WHERE del UPDATE. Si por bug llegara
 * un id ajeno, el UPDATE actualizaría 0 filas y el `findPackagingInCompany`
 * pre-flight ya tiró 404.
 *
 * Transacción: el read pre-flight + el UPDATE + el re-fetch comparten el
 * mismo manager (snapshot isolation). Sin la transacción, una archivación
 * concurrente entre los pasos generaría un 404 con UPDATE de 0 filas
 * (inconsistencia de UX, no de seguridad).
 */
@Injectable()
export class UpdatePackagingAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, dto: UpdatePackagingDto, companyId: number): Promise<Packaging> {
    return this.dataSource.transaction<Packaging>(async (manager) => {
      const existing = await findPackagingInCompany(manager, id, companyId);

      const patch: Partial<Packaging> = {};
      if (dto.name !== undefined) {
        patch.name = dto.name.trim();
      }
      if (dto.value !== undefined) {
        patch.value = dto.value;
      }

      if (Object.keys(patch).length === 0) {
        return existing;
      }

      try {
        await manager.update(Packaging, { id: String(id), company_id: String(companyId) }, patch);
      } catch (error) {
        translatePackagingConstraintError(error);
        throw error;
      }

      return findPackagingInCompany(manager, id, companyId);
    });
  }
}
