import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { TicketSetting, TicketSettingType } from '../entities/ticket-setting.entity';

/**
 * Datos del actor que dispara el seed (snapshot informacional; no se persiste
 * en `ticket_settings` porque la entidad no tiene `created_by`, pero mantenemos
 * la firma consistente con `CreateDefaultWalletAction`/`CreateDefaultAppSettingsAction`
 * para que `RegisterAction` reuse la misma estructura `createdBy`).
 */
export interface DefaultTicketSettingsCreator {
  id: number;
  fullName: string;
}

export interface CreateDefaultTicketSettingsInput {
  companyId: number;
  /** Reservado por simetría con otros seeds. No se persiste en `ticket_settings`. */
  createdBy: DefaultTicketSettingsCreator;
}

/**
 * Prefijos por defecto. Espejo del seed `seedEssentials` de PlacePos.
 *
 * El cliente local de PlacePos crea las 5 rows con prefix = '' (cadena
 * vacía) — el helper `formatTicketNumber` produce solo el número padded
 * cuando `prefix` es vacío. Para evitar cargar al frontend con la lógica
 * "es vacío, omite el guion" y mantener paridad con clientes que esperan
 * `null` para "sin prefijo", aquí seedeamos prefix = null y suffix = null.
 *
 * Si el owner quiere personalizar (ej. "F" para SALE, "NC" para
 * CREDIT_NOTE), lo hace vía `PUT /ticket-settings/:ticket_type` después
 * del registro.
 */
const DEFAULT_PREFIXES: Record<
  TicketSettingType,
  { prefix: string | null; suffix: string | null }
> = {
  [TicketSettingType.ORDER]: { prefix: null, suffix: null },
  [TicketSettingType.SALE]: { prefix: null, suffix: null },
  [TicketSettingType.CREDIT_NOTE]: { prefix: null, suffix: null },
  [TicketSettingType.DEBIT_NOTE]: { prefix: null, suffix: null },
  [TicketSettingType.PURCHASE]: { prefix: null, suffix: null },
};

/**
 * Crea las 5 filas iniciales de `ticket_settings` para una company recién
 * registrada — una por cada `TicketSettingType`. `current_number = 0`
 * (pre-incremento) para que el primer folio formateado sea `001`.
 *
 * Igual que `CreateDefaultWalletAction`:
 *   - Recibe `EntityManager` para participar de la transacción del caller.
 *   - Si cualquier INSERT falla → rollback total del registro (Company,
 *     User, Wallet "Efectivo", AppSettings defaults, etc.).
 *   - Idempotencia NO necesaria: la transacción se ejecuta exactamente una
 *     vez por company en el flujo `POST /auth/register`. Si por bug se
 *     llamara dos veces, el UNIQUE `(company_id, ticket_type)` del index
 *     `idx_ticket_settings_company_type_unique` haría fallar el segundo
 *     INSERT.
 *
 * Cómo cablearlo (instrucciones para el integrador en `RegisterAction`):
 *
 *   1. Importar `CreateDefaultTicketSettingsAction` desde
 *      `@/modules/ticket-settings/actions/create-default-ticket-settings.action`
 *      (re-exportado por `TicketSettingsModule`).
 *
 *   2. Añadir `TicketSettingsModule` a `AuthModule.imports`.
 *
 *   3. Inyectarlo en el constructor de `RegisterAction`:
 *        constructor(
 *          private readonly dataSource: DataSource,
 *          private readonly jwtIssuer: JwtIssuerService,
 *          private readonly createDefaultWalletAction: CreateDefaultWalletAction,
 *          private readonly createDefaultTicketSettingsAction: CreateDefaultTicketSettingsAction,
 *          private readonly createDefaultAppSettingsAction: CreateDefaultAppSettingsAction,
 *        ) {}
 *
 *   4. Llamarlo dentro de la transacción del registro, DESPUÉS de crear
 *      la Company y el User owner, ANTES del `return`:
 *        await this.createDefaultTicketSettingsAction.execute(manager, {
 *          companyId: Number(savedCompany.id),
 *          createdBy: {
 *            id: Number(savedUser.id),
 *            fullName: `${savedUser.name} ${savedUser.lastname}`.trim(),
 *          },
 *        });
 */
@Injectable()
export class CreateDefaultTicketSettingsAction {
  async execute(
    manager: EntityManager,
    input: CreateDefaultTicketSettingsInput,
  ): Promise<TicketSetting[]> {
    const repo = manager.getRepository(TicketSetting);

    const rows = Object.values(TicketSettingType).map((ticketType) => {
      const defaults = DEFAULT_PREFIXES[ticketType];
      return repo.create({
        company_id: String(input.companyId),
        ticket_type: ticketType,
        current_number: 0,
        prefix: defaults.prefix,
        suffix: defaults.suffix,
      });
    });

    return repo.save(rows);
  }
}
