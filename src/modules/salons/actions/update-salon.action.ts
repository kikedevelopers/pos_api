import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateSalonDto } from '../dto/update-salon.dto';
import { Salon } from '../entities/salon.entity';
import { translateSalonConstraintError } from '../internal/constraint-errors';
import { findSalonInCompany } from '../internal/salon-lookups';

/** Renombra un salón (`PUT /salons/:id`). 404 si no existe/archivado; 409 UNIQUE. */
@Injectable()
export class UpdateSalonAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, dto: UpdateSalonDto, companyId: number): Promise<Salon> {
    return this.dataSource.transaction<Salon>(async (manager) => {
      const existing = await findSalonInCompany(manager, id, companyId);
      if (existing.is_archived) {
        throw new NotFoundException('Salón no encontrado');
      }

      if (dto.name === undefined) {
        return existing;
      }
      const trimmed = dto.name.trim();
      if (!trimmed) {
        throw new BadRequestException('El nombre del salón es requerido');
      }

      try {
        await manager.update(
          Salon,
          { id: String(id), company_id: String(companyId) },
          { name: trimmed },
        );
      } catch (error) {
        translateSalonConstraintError(error);
        throw error;
      }

      return findSalonInCompany(manager, id, companyId);
    });
  }
}
