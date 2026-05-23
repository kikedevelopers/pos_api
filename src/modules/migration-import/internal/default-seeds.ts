import type { EntityManager } from 'typeorm';

import type { CreateDefaultAlertConfigsAction } from '@/modules/alert-configs/actions/create-default-alert-configs.action';
import type { CreateDefaultAppSettingsAction } from '@/modules/app-settings/actions/create-default-app-settings.action';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import type { CreateDefaultTicketSettingsAction } from '@/modules/ticket-settings/actions/create-default-ticket-settings.action';
import type { CreateDefaultWalletAction } from '@/modules/wallets/actions/create-default-wallet.action';

/**
 * Resultado de los seeds: ids reales de los registros que se acaban de crear.
 * Se usan para remapear referencias sintéticas del ZIP ("1") y para que
 * `sale_payments`/`expenses` puedan apuntar a `account_id`/`source_id` reales.
 */
export interface DefaultSeedsResult {
  walletId: string;
  cashRegisterId: string;
}

export interface DefaultSeedsInput {
  manager: EntityManager;
  companyId: number;
  ownerUserId: number;
  ownerFullName: string;
}

/**
 * Ejecuta los seeds esenciales tras crear Company + User. Se ejecuta dentro
 * de la misma transacción del import — si algo falla, rollback total.
 *
 * Reusamos los `CreateDefault*Action` del módulo `auth` para mantener una
 * sola fuente de verdad sobre los defaults.
 */
export async function seedEssentials(
  input: DefaultSeedsInput,
  walletAction: CreateDefaultWalletAction,
  ticketAction: CreateDefaultTicketSettingsAction,
  appSettingsAction: CreateDefaultAppSettingsAction,
  alertConfigsAction: CreateDefaultAlertConfigsAction,
): Promise<DefaultSeedsResult> {
  const createdBy = { id: input.ownerUserId, fullName: input.ownerFullName };
  const { companyId, manager } = input;

  // Wallet "Efectivo".
  const wallet = await walletAction.execute(manager, { companyId, createdBy });

  // Ticket settings (6 tipos).
  await ticketAction.execute(manager, { companyId, createdBy });

  // App settings (color_mode, pos_margins_enabled).
  await appSettingsAction.execute(manager, { companyId, createdBy });

  // Alert configs (INACTIVE_CUSTOMER deshabilitada).
  await alertConfigsAction.execute(manager, { companyId, createdBy });

  // Cash register para el owner. No hay action default — la creamos aquí.
  // El user_id apunta al owner recién creado para que pueda operar caja.
  const cashRegisterRepo = manager.getRepository(CashRegister);
  const cashRegister = await cashRegisterRepo.save(
    cashRegisterRepo.create({
      company_id: String(companyId),
      user_id: String(input.ownerUserId),
      balance: 0,
      base_amount: 0,
    }),
  );

  return {
    walletId: wallet.id,
    cashRegisterId: cashRegister.id,
  };
}
