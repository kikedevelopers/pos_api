import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { TicketSetting, TicketSettingType } from '../entities/ticket-setting.entity';
import { formatTicketNumber } from '../internal/format-ticket-number';

/**
 * Resultado del incremento atómico. Espejo del flujo PlacePos:
 *   - `number` es el nuevo `current_number` (post-incremento).
 *   - `formatted` es `{prefix}-{padded}-{suffix}` listo para persistir en
 *     `ticket_number` de la venta/compra/nota.
 */
export interface IncrementTicketNumberResult {
  number: number;
  formatted: string;
}

/**
 * Incremento atómico del contador de folios para un (company, ticket_type).
 *
 * --------------------------------------------------------------------------
 * Por qué `UPDATE ... RETURNING` y NO `findOne + ++ + save`
 * --------------------------------------------------------------------------
 *
 * Dos ventas concurrentes que leyeran `current_number = 5` con `findOne` y
 * grabaran `6` con `save` terminarían con dos ventas distintas usando el
 * mismo folio (5 o 6 dependiendo de quién escribe último). El UPDATE
 * atómico de Postgres adquiere row-level lock implícito y el RETURNING
 * devuelve el valor POST-actualización único para cada transacción que toca
 * la misma fila — los folios siempre quedan disjuntos.
 *
 * El UNIQUE compuesto `(company_id, ticket_type)` en migración garantiza
 * que solo una fila matchea el WHERE.
 *
 * --------------------------------------------------------------------------
 * Diseño del API
 * --------------------------------------------------------------------------
 *
 * - Recibe `EntityManager` (NO `DataSource`): se ejecuta DENTRO de la
 *   transacción del caller (ej. `CreateSaleAction`, `CreatePurchaseAction`).
 *   Si el caller hace rollback, el incremento también — clave para no
 *   quemar folios cuando una venta falla a mitad de proceso.
 *
 * - Si NO existe row para (company, type) lanza `InternalServerErrorException`:
 *   el seed `CreateDefaultTicketSettingsAction` invocado por `RegisterAction`
 *   debe haber creado las 5 rows iniciales. Su ausencia es un bug de
 *   provisioning, no un error de usuario.
 */
@Injectable()
export class IncrementTicketNumberAction {
  async execute(
    manager: EntityManager,
    companyId: number,
    ticketType: TicketSettingType,
  ): Promise<IncrementTicketNumberResult> {
    // `execute()` devuelve `UpdateResult` con `raw: any` (típico en TypeORM).
    // Lo capturamos explícitamente para suprimir el warning de
    // `no-unsafe-assignment` y forzar el narrow estructural inmediato.
    const updateResult = await manager
      .createQueryBuilder()
      .update(TicketSetting)
      .set({
        current_number: () => 'current_number + 1',
        updated_at: () => 'now()',
      })
      .where('company_id = :companyId AND ticket_type = :ticketType', {
        companyId,
        ticketType,
      })
      .returning(['current_number', 'prefix', 'suffix'])
      .execute();

    const raw = updateResult.raw as unknown;

    if (!Array.isArray(raw) || raw.length === 0) {
      throw new InternalServerErrorException(
        `Configuración de folio no encontrada para ticket_type=${ticketType}. ` +
          `El seed inicial de ticket_settings debió crearse en POST /auth/register.`,
      );
    }

    const row = raw[0] as {
      current_number: number;
      prefix: string | null;
      suffix: string | null;
    };

    const number = Number(row.current_number);
    const formatted = formatTicketNumber(row.prefix, row.suffix, number);

    return { number, formatted };
  }
}
