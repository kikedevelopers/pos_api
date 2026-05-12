import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateTicketSettingDto } from '../dto/update-ticket-setting.dto';
import { TicketSetting, TicketSettingType } from '../entities/ticket-setting.entity';

/**
 * Actualiza `prefix` y/o `suffix` de la configuración de folio de un
 * `(company_id, ticket_type)`. Endpoint `PUT /ticket-settings/:ticket_type`.
 *
 * Reglas:
 *   - `current_number` NO se modifica vía este endpoint — solo lo cambia
 *     `IncrementTicketNumberAction` durante la creación de una venta/compra/nota.
 *     Permitir cambiarlo desde la API abriría la puerta a folios duplicados
 *     en el negocio.
 *
 *   - `prefix`/`suffix` `null` o vacío se aceptan (sin prefix/suffix).
 *
 *   - 404 si no existe row para (company, ticket_type). En condiciones normales
 *     siempre debería existir (seed del registro). Si falta es un bug.
 */
@Injectable()
export class UpdateTicketSettingAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    ticketType: TicketSettingType,
    dto: UpdateTicketSettingDto,
    companyId: number,
  ): Promise<TicketSetting> {
    return this.dataSource.transaction<TicketSetting>(async (manager) => {
      const existing = await manager.findOne(TicketSetting, {
        where: { company_id: String(companyId), ticket_type: ticketType },
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

      await manager.update(
        TicketSetting,
        { id: existing.id, company_id: String(companyId) },
        patch,
      );

      return manager.findOneOrFail(TicketSetting, {
        where: { company_id: String(companyId), ticket_type: ticketType },
      });
    });
  }
}
