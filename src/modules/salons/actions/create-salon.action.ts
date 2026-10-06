import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateSalonDto } from '../dto/create-salon.dto';
import { Salon } from '../entities/salon.entity';
import { translateSalonConstraintError } from '../internal/constraint-errors';

export interface SalonCreator {
  id: number;
  fullName: string;
}

/**
 * Crea un salón (`POST /salons`). `name` no-blank (400), UNIQUE per-company
 * (409). Auditoría congelada desde el actor autenticado.
 */
@Injectable()
export class CreateSalonAction {
  private readonly logger = new Logger(CreateSalonAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(dto: CreateSalonDto, companyId: number, createdBy: SalonCreator): Promise<Salon> {
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('El nombre del salón es requerido');
    }

    const saved = await this.dataSource.transaction<Salon>(async (manager) => {
      const salon = manager.create(Salon, {
        company_id: String(companyId),
        name,
        is_archived: false,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });
      try {
        return await manager.save(Salon, salon);
      } catch (error) {
        translateSalonConstraintError(error);
        throw error;
      }
    });

    this.logger.log({
      event: 'salon.created',
      actorId: createdBy.id,
      companyId,
      salonId: Number(saved.id),
    });
    return saved;
  }
}
