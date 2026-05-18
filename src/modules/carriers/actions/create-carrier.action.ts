import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateCarrierDto } from '../dto/create-carrier.dto';
import { Carrier } from '../entities/carrier.entity';
import { translateCarrierConstraintError } from '../internal/constraint-errors';

/**
 * Actor que crea el carrier. Evita propagar `AuthUser` completo.
 */
export interface CarrierCreator {
  id: number;
  fullName: string;
}

/**
 * Crea un transportista (`POST /carriers`).
 *
 * Reglas:
 *   - `name` obligatorio, no-blank. 400 si vacío.
 *   - UNIQUE per-company sobre `lower(btrim(name))` para activos: 409 si
 *     colisión.
 */
@Injectable()
export class CreateCarrierAction {
  private readonly logger = new Logger(CreateCarrierAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CreateCarrierDto,
    companyId: number,
    createdBy: CarrierCreator,
  ): Promise<Carrier> {
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('El nombre del transportista es requerido');
    }

    const saved = await this.dataSource.transaction<Carrier>(async (manager) => {
      const carrier = manager.create(Carrier, {
        company_id: String(companyId),
        name,
        identification: dto.identification?.trim() || null,
        phone: dto.phone?.trim() || null,
        email: dto.email?.trim() || null,
        notes: dto.notes?.trim() || null,
        is_archived: false,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });

      try {
        return await manager.save(Carrier, carrier);
      } catch (error) {
        translateCarrierConstraintError(error);
        throw error;
      }
    });

    this.logger.log({
      event: 'carrier.created',
      companyId,
      carrierId: Number(saved.id),
      actorId: createdBy.id,
    });

    return saved;
  }
}
