import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource, Not } from 'typeorm';

import type { UpdateTicketSettingDto } from '../dto/update-ticket-setting.dto';
import { TicketSetting } from '../entities/ticket-setting.entity';

/**
 * Actualiza `prefix` y/o `suffix` de una `ticket_settings` por su id, dentro
 * de la company autenticada. Endpoint `PUT /ticket-settings/:id` — espejo
 * PlacePos.
 *
 * Reglas:
 *   - `current_number` NO se modifica vía este endpoint — solo lo cambia
 *     `IncrementTicketNumberAction` durante la creación de una venta/compra/nota.
 *     Permitir cambiarlo desde la API abriría la puerta a folios duplicados
 *     en el negocio.
 *
 *   - `prefix`/`suffix` `null` o vacío se aceptan (sin prefix/suffix).
 *
 *   - 404 si no existe row con ese `id` dentro de la company (también si
 *     existe pero pertenece a otra company — anti-IDOR cross-tenant).
 *
 *   - 422 si el `prefix` resultante ya está en uso por OTRA fila de la misma
 *     company (UNIQUE soft a nivel app — PlacePos enforced este invariant).
 */
@Injectable()
export class UpdateTicketSettingAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    id: number,
    dto: UpdateTicketSettingDto,
    companyId: number,
  ): Promise<TicketSetting> {
    return this.dataSource.transaction<TicketSetting>(async (manager) => {
      const existing = await manager.findOne(TicketSetting, {
        where: { id: String(id), company_id: String(companyId) },
      });
      if (!existing) {
        throw new NotFoundException('Configuración de folio no encontrada');
      }

      // Normaliza '' → null para que el helper `formatTicketNumber` evite el
      // separador. Solo aplicamos cuando la clave viene en el DTO; ausencia
      // === no tocar.
      const patch: Partial<Pick<TicketSetting, 'prefix' | 'suffix'>> = {};
      if (Object.prototype.hasOwnProperty.call(dto, 'prefix')) {
        patch.prefix = dto.prefix && dto.prefix.length > 0 ? dto.prefix : null;
      }
      if (Object.prototype.hasOwnProperty.call(dto, 'suffix')) {
        patch.suffix = dto.suffix && dto.suffix.length > 0 ? dto.suffix : null;
      }

      if (Object.keys(patch).length === 0) {
        // Nada que actualizar — devolvemos el row tal cual. Idempotente.
        return existing;
      }

      // Validación de prefix duplicado dentro de la company. Solo aplica si
      // el patch trae prefix no-nulo y distinto del actual.
      if (
        Object.prototype.hasOwnProperty.call(patch, 'prefix') &&
        patch.prefix !== null &&
        patch.prefix !== existing.prefix
      ) {
        const collision = await manager.findOne(TicketSetting, {
          where: {
            company_id: String(companyId),
            prefix: patch.prefix,
            id: Not(existing.id),
          },
        });
        if (collision) {
          throw new UnprocessableEntityException({
            message: `El prefix "${patch.prefix}" ya está en uso por otra configuración de folio.`,
            payload: { code: 'TICKET_PREFIX_DUPLICATE' },
          });
        }
      }

      await manager.update(
        TicketSetting,
        { id: existing.id, company_id: String(companyId) },
        patch,
      );

      return manager.findOneOrFail(TicketSetting, {
        where: { id: existing.id, company_id: String(companyId) },
      });
    });
  }
}
