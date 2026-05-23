import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { PG_UNIQUE_VIOLATION } from '@/modules/auth/internal/pg-errors';

import type { UpdateMeDto } from '../dto/update-me.dto';
import { User } from '../entities/user.entity';

/**
 * Actualiza el perfil propio del usuario autenticado (`PUT /users/me`).
 *
 * Reglas:
 *   - Solo se tocan los campos presentes en el DTO (update parcial). El email
 *     se almacena en lowercase trim para no chocar con el UNIQUE GLOBAL por
 *     diferencias de casing — mismo invariante que `RegisterAction` mantiene.
 *   - `email` UNIQUE GLOBAL → si el INSERT viola la restricción, el catch
 *     traduce a 409 `EMAIL_TAKEN`. Esto cubre la race condition donde dos
 *     PUTs concurrentes intentan tomar el mismo email.
 *   - Si no hay nada que actualizar (DTO vacío) devolvemos el row tal cual
 *     sin tocar `updated_at`.
 *
 * §8.8 CLAUDE.md: TODA mutación en `dataSource.transaction`. Aunque sea un
 * solo UPDATE, defensa en profundidad: futuras auditorías que se sumen al
 * action (email_changes log, notificaciones, etc.) quedarán dentro de la
 * misma tx sin re-revisión.
 */
@Injectable()
export class UpdateMeAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(userId: number, companyId: number, dto: UpdateMeDto): Promise<User> {
    return this.dataSource.transaction<User>(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: String(userId), company_id: String(companyId) },
      });

      if (!user) {
        throw new NotFoundException('Usuario no encontrado');
      }

      const updatePayload: Partial<User> = {};

      if (dto.name !== undefined) {
        updatePayload.name = dto.name.trim();
      }
      if (dto.lastname !== undefined) {
        updatePayload.lastname = dto.lastname.trim();
      }
      if (dto.email !== undefined) {
        // Normalización defensiva: el contrato declara emails case-insensitive.
        updatePayload.email = dto.email.trim().toLowerCase();
      }

      if (Object.keys(updatePayload).length > 0) {
        try {
          await manager.update(
            User,
            { id: String(userId), company_id: String(companyId) },
            updatePayload,
          );
        } catch (error) {
          if (error instanceof QueryFailedError) {
            const code = (error as QueryFailedError & { code?: string }).code;
            if (code === PG_UNIQUE_VIOLATION) {
              throw new ConflictException({
                message: 'Ya existe una cuenta con ese email',
                payload: { code: 'EMAIL_TAKEN' },
              });
            }
          }
          throw error;
        }
      }

      const updated = await manager.findOne(User, {
        where: { id: String(userId), company_id: String(companyId) },
      });

      if (!updated) {
        // Carrera improbable: el row fue borrado entre el UPDATE y el SELECT.
        throw new NotFoundException('Usuario no encontrado');
      }

      return updated;
    });
  }
}
