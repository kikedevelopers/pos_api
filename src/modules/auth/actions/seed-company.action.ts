import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { CreateDefaultAlertConfigsAction } from '@/modules/alert-configs/actions/create-default-alert-configs.action';
import { CreateDefaultAppSettingsAction } from '@/modules/app-settings/actions/create-default-app-settings.action';
import { CreateDefaultTicketSettingsAction } from '@/modules/ticket-settings/actions/create-default-ticket-settings.action';
import { CreateDefaultWalletAction } from '@/modules/wallets/actions/create-default-wallet.action';

export interface SeedCompanyInput {
  companyId: number;
  createdBy: { id: number; fullName: string };
}

/**
 * Siembra los datos esenciales de una company recién creada: wallet,
 * ticket_settings, app_settings y alert_configs.
 *
 * NO crea suscripción: la suscripción de vigencia es ÚNICA por owner (vive en
 * su negocio principal) y la crea `RegisterAction`. Las sucursales comparten
 * esa suscripción, así que `CreateBranchAction` usa este seed SIN sub.
 *
 * Diseñada para correr DENTRO de una transacción (recibe el `manager`).
 */
@Injectable()
export class SeedCompanyAction {
  constructor(
    private readonly createDefaultWalletAction: CreateDefaultWalletAction,
    private readonly createDefaultTicketSettingsAction: CreateDefaultTicketSettingsAction,
    private readonly createDefaultAppSettingsAction: CreateDefaultAppSettingsAction,
    private readonly createDefaultAlertConfigsAction: CreateDefaultAlertConfigsAction,
  ) {}

  async execute(manager: EntityManager, input: SeedCompanyInput): Promise<void> {
    const { companyId, createdBy } = input;

    await this.createDefaultWalletAction.execute(manager, { companyId, createdBy });
    await this.createDefaultTicketSettingsAction.execute(manager, { companyId, createdBy });
    await this.createDefaultAppSettingsAction.execute(manager, { companyId, createdBy });
    await this.createDefaultAlertConfigsAction.execute(manager, { companyId, createdBy });
  }
}
