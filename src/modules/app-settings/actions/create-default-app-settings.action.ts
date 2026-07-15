import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';

export interface DefaultAppSettingsCreator {
  id: number;
  fullName: string;
}

export interface CreateDefaultAppSettingsInput {
  companyId: number;
  /** Reservado por simetría con otros seeds. No se persiste en `app_settings`. */
  createdBy: DefaultAppSettingsCreator;
}

/**
 * Defaults espejo de PlacePos `app-settings.routes.ts`:
 *
 *   - `app_color_mode = 'white'` — el GET /app-settings devuelve 'white'
 *     si la row no existe; insertamos explícitamente para que el cliente
 *     vea el valor sin depender del fallback.
 *   - `pos_margins_enabled = 'false'` — feature off por defecto.
 *   - `include_orders_in_reports = 'false'` — los pedidos ORDER NO se cuentan
 *     como ingreso en los informes hasta que el owner active el flag.
 *
 * `pos_margins` NO se inserta hasta que el usuario active la feature y
 * configure los porcentajes vía `PUT /app-settings/pos-margins`.
 */
const DEFAULT_SETTINGS: Array<{ key: string; value: string }> = [
  { key: APP_SETTING_KEYS.APP_COLOR_MODE, value: 'white' },
  { key: APP_SETTING_KEYS.POS_MARGINS_ENABLED, value: 'false' },
  { key: APP_SETTING_KEYS.INCLUDE_ORDERS_IN_REPORTS, value: 'false' },
];

/**
 * Crea los settings por defecto para una company recién registrada.
 *
 * Cómo cablearlo (instrucciones para el integrador en `RegisterAction`):
 *
 *   1. Importar `CreateDefaultAppSettingsAction` desde
 *      `@/modules/app-settings/actions/create-default-app-settings.action`
 *      (re-exportado por `AppSettingsModule`).
 *
 *   2. Añadir `AppSettingsModule` a `AuthModule.imports`.
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
 *   4. Llamarlo DENTRO de la transacción del registro, DESPUÉS de crear
 *      Company y User owner, en paralelo lógico con los demás seeds:
 *        await this.createDefaultAppSettingsAction.execute(manager, {
 *          companyId: Number(savedCompany.id),
 *          createdBy: {
 *            id: Number(savedUser.id),
 *            fullName: `${savedUser.name} ${savedUser.lastname}`.trim(),
 *          },
 *        });
 *
 * Igual que `CreateDefaultWalletAction`/`CreateDefaultTicketSettingsAction`:
 *   - Recibe `EntityManager` para participar de la transacción del caller.
 *   - Si cualquier INSERT falla → rollback total del registro.
 */
@Injectable()
export class CreateDefaultAppSettingsAction {
  async execute(
    manager: EntityManager,
    input: CreateDefaultAppSettingsInput,
  ): Promise<AppSetting[]> {
    const repo = manager.getRepository(AppSetting);

    const rows = DEFAULT_SETTINGS.map(({ key, value }) =>
      repo.create({
        company_id: String(input.companyId),
        key,
        value,
      }),
    );

    return repo.save(rows);
  }
}
