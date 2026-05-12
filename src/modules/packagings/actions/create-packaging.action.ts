import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreatePackagingDto } from '../dto/create-packaging.dto';
import { Packaging } from '../entities/packaging.entity';
import { translatePackagingConstraintError } from '../internal/constraint-errors';

/**
 * Datos del actor creador. Evita propagar el `AuthUser` completo y deja la
 * firma desacoplada del shape del JWT.
 */
export interface PackagingCreator {
  id: number;
  fullName: string;
}

/**
 * Crea un empaque dentro de la company autenticada.
 *
 *   - `name` se trimea antes de persistir (paridad PlacePos).
 *   - Colisión por `(company_id, lower(name))` → 409 con
 *     `code: PACKAGING_NAME_TAKEN`. La detección se hace por nombre del
 *     índice en la traducción del `QueryFailedError`.
 *   - `company_id`, `created_by`, `created_by_id` se asignan desde los
 *     parámetros — NUNCA del DTO.
 *
 * Transacción: el INSERT vive dentro de `dataSource.transaction` aunque sea
 * "un solo paso" — §8.8 del CLAUDE.md. Defensa en profundidad para que
 * futuros side-effects (triggers, audit en DB) hereden atomicidad sin que
 * nadie revise.
 */
@Injectable()
export class CreatePackagingAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CreatePackagingDto,
    companyId: number,
    createdBy: PackagingCreator,
  ): Promise<Packaging> {
    return this.dataSource.transaction<Packaging>(async (manager) => {
      const packaging = manager.create(Packaging, {
        company_id: String(companyId),
        name: dto.name.trim(),
        value: dto.value,
        is_archived: false,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });

      try {
        return await manager.save(Packaging, packaging);
      } catch (error) {
        translatePackagingConstraintError(error);
        throw error;
      }
    });
  }
}
