import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateCompanyDto } from '../dto/update-company.dto';
import { Company } from '../entities/company.entity';

/**
 * Actualiza el perfil de la Company autenticada.
 *
 * Espejo de PlacePos `PUT /companies/:id`. El controller ya validó que
 * `:companyId` URL === `companyId` JWT (anti-cross-tenant); aquí solo nos
 * apoyamos en el `companyId` recibido como parámetro y NUNCA en un valor
 * del body.
 *
 * Reglas:
 *   - Update parcial: solo se tocan los campos presentes en el DTO.
 *   - Cadenas vacías en `document_number`, `address`, `email`,
 *     `phone_number` se persisten como `null` (paridad PlacePos:
 *     `data.field || null`). El `name` no admite vacío y ya fue
 *     rechazado por el `IsNotEmpty` del DTO.
 *   - Si no hay nada que actualizar (DTO vacío), devolvemos la company
 *     tal cual sin tocar `updated_at`.
 *
 * §8.8: toda mutación va en `dataSource.transaction`, incluso siendo "un
 * solo paso".
 */
@Injectable()
export class UpdateCompanyAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, dto: UpdateCompanyDto): Promise<Company> {
    return this.dataSource.transaction<Company>(async (manager) => {
      const company = await manager.findOne(Company, {
        where: { id: String(companyId) },
      });

      if (!company) {
        throw new NotFoundException('No se encontró información de la empresa');
      }

      const updatePayload: Partial<Company> = {};

      if (dto.name !== undefined) {
        // class-validator ya garantizó no-vacío; mantenemos el trim
        // por paridad estricta con PlacePos.
        updatePayload.name = dto.name.trim();
      }
      if (dto.document_number !== undefined) {
        updatePayload.document_number = dto.document_number || null;
      }
      if (dto.address !== undefined) {
        updatePayload.address = dto.address || null;
      }
      if (dto.email !== undefined) {
        updatePayload.email = dto.email || null;
      }
      if (dto.phone_number !== undefined) {
        updatePayload.phone_number = dto.phone_number || null;
      }
      if (dto.break_even_amount !== undefined) {
        updatePayload.break_even_amount = dto.break_even_amount;
      }
      if (dto.break_even_period_days !== undefined) {
        updatePayload.break_even_period_days = dto.break_even_period_days;
      }

      if (Object.keys(updatePayload).length > 0) {
        await manager.update(Company, { id: String(companyId) }, updatePayload);
      }

      // Re-fetch para devolver `updated_at` actualizado y aplicar los
      // transformers numéricos sobre los datos persistidos.
      const updated = await manager.findOne(Company, {
        where: { id: String(companyId) },
      });

      if (!updated) {
        // Carrera: la company fue borrada entre el UPDATE y el SELECT.
        // Improbable en operación normal (no exponemos DELETE).
        throw new NotFoundException('No se encontró información de la empresa');
      }

      return updated;
    });
  }
}
