import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateCarrierDto } from '../dto/update-carrier.dto';
import { Carrier } from '../entities/carrier.entity';
import { findCarrierInCompany } from '../internal/carrier-lookups';
import { translateCarrierConstraintError } from '../internal/constraint-errors';

/**
 * Actualiza datos de perfil de un carrier (`PUT /carriers/:id`).
 *
 *   - 404 si no existe o pertenece a otra company.
 *   - 404 si está archivado (no se edita archivado).
 *   - 400 si `name` definido pero blank.
 *   - 409 si colisión UNIQUE per-company.
 */
@Injectable()
export class UpdateCarrierAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, dto: UpdateCarrierDto, companyId: number): Promise<Carrier> {
    return this.dataSource.transaction<Carrier>(async (manager) => {
      const existing = await findCarrierInCompany(manager, id, companyId);

      if (existing.is_archived) {
        throw new NotFoundException('Transportista no encontrado');
      }

      const patch: Partial<Carrier> = {};
      if (dto.name !== undefined) {
        const trimmed = dto.name.trim();
        if (!trimmed) {
          throw new BadRequestException('El nombre del transportista es requerido');
        }
        patch.name = trimmed;
      }
      if (dto.identification !== undefined) {
        patch.identification = dto.identification?.trim() || null;
      }
      if (dto.phone !== undefined) {
        patch.phone = dto.phone?.trim() || null;
      }
      if (dto.email !== undefined) {
        patch.email = dto.email?.trim() || null;
      }
      if (dto.notes !== undefined) {
        patch.notes = dto.notes?.trim() || null;
      }

      if (Object.keys(patch).length === 0) {
        return existing;
      }

      try {
        await manager.update(Carrier, { id: String(id), company_id: String(companyId) }, patch);
      } catch (error) {
        translateCarrierConstraintError(error);
        throw error;
      }

      return findCarrierInCompany(manager, id, companyId);
    });
  }
}
