import { HttpException, Injectable, Logger } from '@nestjs/common';
import Big from 'big.js';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber } from '@/common/utils/precision';
import { runSerializableWithRetry } from '@/common/utils/serializable-retry';
import { TransferAction } from '@/modules/accounts/actions/transfer.action';
import { ApplyBankAdjustmentAction } from '@/modules/banks/actions/apply-bank-adjustment.action';
import { BankAdjustmentMovementType } from '@/modules/banks/dto/create-bank-adjustment.dto';
import { AdjustCashRegisterAction } from '@/modules/cash-register/actions/adjust-cash-register.action';
import { TransferCashAction } from '@/modules/pos-data/actions/transfer-cash.action';
import { ApplyWalletAdjustmentAction } from '@/modules/wallets/actions/apply-wallet-adjustment.action';
import { WalletAdjustmentMovementType } from '@/modules/wallets/dto/create-wallet-adjustment.dto';

import {
  hashMessage,
  PENDING_ACTION_TTL_MINUTES,
  readMoneyArg,
  type AiToolRequestContext,
} from '../internal/expense-tool-helpers';
import {
  LOCK_PENDING_ACTION_SQL,
  MARK_PENDING_EXECUTED_SQL,
  MARK_PENDING_EXPIRED_SQL,
  UPSERT_PENDING_ACTION_SQL,
} from '../internal/expense-tool-sql';
import {
  checkPendingConfirmation,
  TREASURY_ACTION_TYPES,
  type PendingActionType,
  wrongOperationResult,
} from '../internal/pending-confirmation';
import { readString } from '../internal/tool-args';
import type { AiToolActor } from '../internal/tool-catalog';
import {
  accountLabel,
  buildAdjustmentReason,
  classifyTransferRoute,
  KIND_LABEL,
  MAX_ADJUSTMENT_REASON_LENGTH,
  resolveTreasuryAccount,
  type TreasuryAccount,
  type TreasuryAccountKind,
} from '../internal/treasury-tool-helpers';
import { LOCK_BALANCE_SQL, TREASURY_ACCOUNTS_SQL } from '../internal/treasury-tool-sql';

/** Cuenta tal como quedó en el snapshot de la pendiente. */
interface AccountRef {
  kind: TreasuryAccountKind;
  /** Banco/billetera: su id. Caja: el `user_id` del dueño (así la ubican las acciones). */
  ref_id: number;
  label: string;
  /** Saldo que vio el usuario en el resumen (decimal con 2 cifras). */
  balance: string;
}

interface TransferPayload {
  /** Decimal con 2 cifras ("100000.00"): nunca un float. */
  amount: string;
  from: AccountRef;
  to: AccountRef;
  route:
    | {
        via: 'accounts';
        source_type: 'bank' | 'wallet';
        source_id: number;
        destination_type: 'bank' | 'wallet' | 'user';
        destination_id: number;
      }
    | {
        via: 'cash';
        register_user_id: number;
        destination_type: 'bank' | 'wallet';
        destination_id: number;
      };
}

interface AdjustPayload {
  account: AccountRef;
  target_balance: string;
  reason: string;
}

interface AccountRow {
  kind: TreasuryAccountKind;
  id: string;
  user_id: string | null;
  name: string | null;
  account_number: string | null;
  balance: string | null;
  is_own: boolean;
}

interface PendingRow {
  id: string;
  action_type: PendingActionType;
  payload: TransferPayload | AdjustPayload;
  request_id: string;
  trigger_message_hash: string;
  is_expired: boolean;
}

const money = (value: Big | string): number => preciseNumber(new Big(value), 2);

/** Mensaje legible de una excepción HTTP de las acciones canónicas. */
const httpErrorMessage = (error: HttpException): string => {
  const response = error.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) {
    return message.join('. ');
  }
  return typeof message === 'string' ? message : error.message;
};

/** Lo que el modelo necesita de una cuenta para preguntar: nombre, tipo y saldo. */
const describeAccount = (account: TreasuryAccount): Record<string, unknown> => ({
  name: accountLabel(account),
  kind: KIND_LABEL[account.kind],
  balance: money(account.balance),
});

const toRef = (account: TreasuryAccount): AccountRef => ({
  kind: account.kind,
  ref_id: account.kind === 'cash_register' ? Number(account.user_id) : account.id,
  label: accountLabel(account),
  balance: account.balance.toFixed(2),
});

/** Instrucción al modelo cuando la tarjeta ya muestra el resumen. */
const CARD_PENDING_MESSAGE =
  'AÚN NO se ejecutó. El usuario ya ve el resumen exacto en una tarjeta: NO lo repitas. Pídele en una frase que responda "sí" para hacerlo.';
const CARD_DONE_MESSAGE =
  'Hecho. El usuario ya ve el resultado en una tarjeta: confírmalo en una frase, sin repetir cifras.';

/**
 * Herramientas de ESCRITURA de tesorería de Place: mover saldo entre cajas,
 * bancos y billeteras, y corregir el saldo de una cuenta a un valor objetivo.
 *
 * Mismo flujo de dos turnos que gastos y pedidos, forzado por el servidor:
 *
 *   1. `prepare_treasury_transfer` / `prepare_balance_correction` PREPARAN:
 *      resuelven cada cuenta sin adivinar, validan monto y saldo y guardan la
 *      operación PENDIENTE (`ai_pending_actions`) con el snapshot exacto. No
 *      mueven un peso.
 *   2. `confirm_treasury_action` EJECUTA esa pendiente solo con un "sí"
 *      explícito en una petición POSTERIOR que responda a ESE resumen
 *      (`checkPendingConfirmation`). Pendiente + movimiento hacen commit en la
 *      MISMA transacción SERIALIZABLE, con la pendiente bloqueada: dos "sí"
 *      simultáneos no mueven el dinero dos veces.
 *
 * Las escrituras delegan en las acciones de la app (`TransferAction`,
 * `TransferCashAction`, `ApplyBank/WalletAdjustmentAction`,
 * `AdjustCashRegisterAction`): mismo débito/crédito con lock, mismos
 * `financial_movements` y logs de caja que "Mover saldo" y "Corregir caja".
 *
 * Solo el OWNER/superadmin (igual que esos endpoints, que un empleado no
 * puede usar ni con rol Administrador). Siempre en el negocio de la sesión.
 */
@Injectable()
export class RunAiTreasuryToolAction {
  private readonly logger = new Logger(RunAiTreasuryToolAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly transfer: TransferAction,
    private readonly transferCash: TransferCashAction,
    private readonly bankAdjustment: ApplyBankAdjustmentAction,
    private readonly walletAdjustment: ApplyWalletAdjustmentAction,
    private readonly cashAdjustment: AdjustCashRegisterAction,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // prepare_treasury_transfer
  // ────────────────────────────────────────────────────────────────────────

  async prepareTransfer(
    company_id: number,
    actor: AiToolActor,
    args: Record<string, unknown>,
    context: AiToolRequestContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (!actor.isAdmin) {
      return this.forbidden();
    }
    if (!context?.current_user_message) {
      return this.unavailable();
    }

    const from_query = readString(args, 'from');
    const to_query = readString(args, 'to');
    const amount = readMoneyArg(args, 'amount');
    const accounts = await this.fetchAccounts(company_id, actor.userId);

    const missing: string[] = [];
    if (!from_query) {
      missing.push('cuenta de origen');
    }
    if (!to_query) {
      missing.push('cuenta de destino');
    }
    if (amount.status === 'missing') {
      missing.push('valor');
    }
    if (missing.length > 0 || amount.status === 'invalid') {
      return {
        status: missing.length > 0 ? 'missing_data' : 'invalid_data',
        missing,
        ...(amount.status === 'invalid' ? { invalid: [amount.reason] } : {}),
        accounts: accounts.map(describeAccount),
        message: 'NO se preparó nada. Pregúntale al usuario lo que falta, sin suponerlo.',
      };
    }
    if (!from_query || !to_query || amount.status !== 'ok') {
      return this.unavailable();
    }

    const from = this.resolve(from_query, accounts, 'from');
    if (from.status !== 'ok') {
      return from.result;
    }
    const to = this.resolve(to_query, accounts, 'to');
    if (to.status !== 'ok') {
      return to.result;
    }

    const route = classifyTransferRoute(from.account, to.account);
    if (route.status !== 'ok') {
      return { status: 'unsupported', message: `${route.reason} NO se preparó nada.` };
    }
    if (amount.amount.gt(from.account.balance)) {
      return {
        status: 'insufficient_balance',
        account: accountLabel(from.account),
        available: money(from.account.balance),
        requested: money(amount.amount),
        message: 'Saldo insuficiente: se rechaza. NO se preparó nada. Díselo al usuario.',
      };
    }

    const payload: TransferPayload = {
      amount: amount.amount.toFixed(2),
      from: toRef(from.account),
      to: toRef(to.account),
      route:
        route.via === 'accounts'
          ? {
              via: 'accounts',
              source_type: route.source_type,
              source_id: from.account.id,
              destination_type: route.destination_type,
              destination_id: route.destination_id,
            }
          : {
              via: 'cash',
              register_user_id: route.register_user_id,
              destination_type: route.destination_type,
              destination_id: to.account.id,
            },
    };
    const saved = await this.savePending(
      company_id,
      actor.userId,
      'TRANSFER_FUNDS',
      payload,
      context,
    );
    if (saved !== 'saved') {
      return this.notSaved(saved);
    }

    return {
      status: 'confirmation_required',
      summary: {
        operation: 'transfer',
        amount: money(payload.amount),
        from: {
          name: payload.from.label,
          kind: KIND_LABEL[payload.from.kind],
          balance: money(from.account.balance),
          balance_after: money(from.account.balance.minus(amount.amount)),
        },
        to: {
          name: payload.to.label,
          kind: KIND_LABEL[payload.to.kind],
          balance: money(to.account.balance),
          balance_after: money(to.account.balance.plus(amount.amount)),
        },
      },
      message: CARD_PENDING_MESSAGE,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // prepare_balance_correction
  // ────────────────────────────────────────────────────────────────────────

  async prepareCorrection(
    company_id: number,
    actor: AiToolActor,
    args: Record<string, unknown>,
    context: AiToolRequestContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (!actor.isAdmin) {
      return this.forbidden();
    }
    if (!context?.current_user_message) {
      return this.unavailable();
    }

    const account_query = readString(args, 'account');
    const target = readMoneyArg(args, 'target_balance', { allow_zero: true });
    const reason = buildAdjustmentReason(args?.reason);
    const accounts = await this.fetchAccounts(company_id, actor.userId);

    const missing: string[] = [];
    const invalid: string[] = [];
    if (!account_query) {
      missing.push('cuenta a corregir');
    }
    if (target.status === 'missing') {
      missing.push('saldo final');
    }
    if (target.status === 'invalid') {
      invalid.push(target.reason);
    }
    if (reason === null) {
      invalid.push(`El motivo admite máximo ${MAX_ADJUSTMENT_REASON_LENGTH} caracteres.`);
    }
    if (missing.length > 0 || invalid.length > 0) {
      return {
        status: missing.length > 0 ? 'missing_data' : 'invalid_data',
        missing,
        ...(invalid.length > 0 ? { invalid } : {}),
        accounts: accounts.map(describeAccount),
        message: 'NO se preparó nada. Pregúntale al usuario lo que falta, sin suponerlo.',
      };
    }
    if (!account_query || target.status !== 'ok' || reason === null) {
      return this.unavailable();
    }

    const resolved = this.resolve(account_query, accounts, 'account');
    if (resolved.status !== 'ok') {
      return resolved.result;
    }
    const account = resolved.account;
    const difference = target.amount.minus(account.balance);
    if (difference.eq(0)) {
      return {
        status: 'no_change',
        account: accountLabel(account),
        balance: money(account.balance),
        message: 'La cuenta ya tiene ese saldo: no hay nada que corregir. NO se preparó nada.',
      };
    }

    const payload: AdjustPayload = {
      account: toRef(account),
      target_balance: target.amount.toFixed(2),
      reason,
    };
    const saved = await this.savePending(
      company_id,
      actor.userId,
      'ADJUST_BALANCE',
      payload,
      context,
    );
    if (saved !== 'saved') {
      return this.notSaved(saved);
    }

    return {
      status: 'confirmation_required',
      summary: {
        operation: 'adjust',
        account: { name: payload.account.label, kind: KIND_LABEL[account.kind] },
        balance: money(account.balance),
        target_balance: money(target.amount),
        difference: money(difference),
        reason,
      },
      message: CARD_PENDING_MESSAGE,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // confirm_treasury_action
  // ────────────────────────────────────────────────────────────────────────

  async confirm(
    company_id: number,
    actor: AiToolActor,
    context: AiToolRequestContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (!actor.isAdmin) {
      return this.forbidden();
    }
    if (!context?.current_user_message) {
      return this.unavailable();
    }
    const signer = { id: actor.userId, fullName: actor.full_name?.trim() || 'Usuario' };

    try {
      // SERIALIZABLE como "Mover saldo": un 40001 reintenta TODO (pendiente
      // incluida), así que nunca queda un movimiento a medias.
      return await runSerializableWithRetry(this.dataSource, async (manager) => {
        const [pending] = await manager.query<PendingRow[]>(LOCK_PENDING_ACTION_SQL, [
          String(company_id),
          String(actor.userId),
        ]);
        if (!pending) {
          return {
            status: 'no_pending_action',
            message: 'No hay ningún movimiento pendiente de confirmar. NO se ejecutó nada.',
          };
        }
        if (!TREASURY_ACTION_TYPES.has(pending.action_type)) {
          return wrongOperationResult(pending.action_type);
        }

        const expire = (): Promise<unknown> =>
          manager.query(MARK_PENDING_EXPIRED_SQL, [pending.id, String(company_id)]);

        const rejection = checkPendingConfirmation(pending, context);
        if (rejection) {
          if (rejection.expire) {
            await expire();
          }
          return { status: rejection.status, message: rejection.message };
        }

        return pending.action_type === 'TRANSFER_FUNDS'
          ? this.executeTransfer(manager, company_id, pending, signer)
          : this.executeAdjustment(manager, company_id, pending, signer, expire);
      });
    } catch (error) {
      // Rollback completo: ni movimiento, ni pendiente ejecutada.
      if (error instanceof HttpException) {
        return {
          status: 'failed',
          message: `NO se ejecutó: ${httpErrorMessage(error)}. Explícaselo al usuario.`,
        };
      }
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Ejecución (dentro de la transacción de confirmación)
  // ────────────────────────────────────────────────────────────────────────

  private async executeTransfer(
    manager: EntityManager,
    company_id: number,
    pending: PendingRow,
    signer: { id: number; fullName: string },
  ): Promise<Record<string, unknown>> {
    const payload = pending.payload as TransferPayload;
    const { route } = payload;
    const amount = Number(payload.amount);

    if (route.via === 'accounts') {
      await this.transfer.runInTransaction(
        manager,
        {
          sourceType: route.source_type,
          sourceId: route.source_id,
          destinationType: route.destination_type,
          destinationId: route.destination_id,
          amount,
        },
        company_id,
        signer,
      );
    } else {
      await this.transferCash.runInTransaction(
        manager,
        { destinationType: route.destination_type, destinationId: route.destination_id, amount },
        company_id,
        signer,
        route.register_user_id,
      );
    }

    // `result_ref` es un id (bigint): las cuentas afectadas ya están en el payload.
    await manager.query(MARK_PENDING_EXECUTED_SQL, [pending.id, String(company_id), null]);
    const [from_balance, to_balance] = await Promise.all([
      this.readBalance(manager, company_id, payload.from),
      this.readBalance(manager, company_id, payload.to),
    ]);

    this.logger.log({
      event: 'ai.treasury.transferred',
      companyId: company_id,
      userId: signer.id,
      pendingActionId: Number(pending.id),
      amount: payload.amount,
      from: `${payload.from.kind}:${payload.from.ref_id}`,
      to: `${payload.to.kind}:${payload.to.ref_id}`,
    });

    return {
      status: 'executed',
      result: {
        operation: 'transfer',
        amount: money(payload.amount),
        from: { name: payload.from.label, balance: from_balance },
        to: { name: payload.to.label, balance: to_balance },
      },
      message: CARD_DONE_MESSAGE,
    };
  }

  private async executeAdjustment(
    manager: EntityManager,
    company_id: number,
    pending: PendingRow,
    signer: { id: number; fullName: string },
    expire: () => Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    const payload = pending.payload as AdjustPayload;
    const { account } = payload;

    // El saldo que se corrige tiene que ser el que vio el usuario: si cambió
    // (una venta, otro traslado), la diferencia confirmada ya no es la real.
    const [current] = await manager.query<Array<{ balance: string }>>(
      LOCK_BALANCE_SQL[account.kind],
      [String(account.ref_id), String(company_id)],
    );
    const current_balance = new Big(current?.balance ?? 0);
    const missing_account = !current && account.kind !== 'cash_register';
    if (missing_account || !current_balance.eq(account.balance)) {
      await expire();
      return {
        status: 'changed',
        message: missing_account
          ? 'La cuenta ya no existe o fue archivada. NO se corrigió nada.'
          : `El saldo de ${account.label} cambió desde el resumen (ahora ${money(current_balance)}). NO se corrigió nada: vuelve a prepararlo y pide un "sí" nuevo.`,
      };
    }

    const target = new Big(payload.target_balance);
    const difference = target.minus(current_balance);
    if (difference.eq(0)) {
      await expire();
      return { status: 'no_change', message: 'La cuenta ya tiene ese saldo. No se hizo nada.' };
    }

    if (account.kind === 'cash_register') {
      await this.cashAdjustment.runInTransaction(
        manager,
        company_id,
        account.ref_id,
        Number(payload.target_balance),
        payload.reason,
        signer,
      );
    } else {
      const is_income = difference.gt(0);
      const dto = {
        amount: money(difference.abs()),
        description: payload.reason,
      };
      if (account.kind === 'bank') {
        await this.bankAdjustment.runInTransaction(
          manager,
          account.ref_id,
          {
            ...dto,
            movement_type: is_income
              ? BankAdjustmentMovementType.INCOME
              : BankAdjustmentMovementType.EXPENSE,
          },
          company_id,
          signer,
        );
      } else {
        await this.walletAdjustment.runInTransaction(
          manager,
          account.ref_id,
          {
            ...dto,
            movement_type: is_income
              ? WalletAdjustmentMovementType.INCOME
              : WalletAdjustmentMovementType.EXPENSE,
          },
          company_id,
          signer,
        );
      }
    }

    await manager.query(MARK_PENDING_EXECUTED_SQL, [pending.id, String(company_id), null]);
    const balance = await this.readBalance(manager, company_id, account);

    this.logger.log({
      event: 'ai.treasury.adjusted',
      companyId: company_id,
      userId: signer.id,
      pendingActionId: Number(pending.id),
      account: `${account.kind}:${account.ref_id}`,
      previousBalance: current_balance.toFixed(2),
      newBalance: payload.target_balance,
    });

    return {
      status: 'executed',
      result: {
        operation: 'adjust',
        account: { name: account.label },
        balance,
        difference: money(difference),
      },
      message: CARD_DONE_MESSAGE,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internos
  // ────────────────────────────────────────────────────────────────────────

  private async fetchAccounts(company_id: number, user_id: number): Promise<TreasuryAccount[]> {
    const rows = await this.dataSource.query<AccountRow[]>(TREASURY_ACCOUNTS_SQL, [
      String(company_id),
      String(user_id),
    ]);
    // Solo cajas que EXISTEN: nunca se fabrica una (el superadmin no tiene
    // caja de negocio y un ajuste se la crearía).
    return rows.map((row) => ({
      kind: row.kind,
      id: Number(row.id),
      user_id: row.user_id === null ? null : Number(row.user_id),
      name: row.name?.trim() || 'Sin nombre',
      account_number: row.account_number,
      balance: new Big(row.balance ?? 0),
      is_own: row.is_own === true,
    }));
  }

  private resolve(
    query: string,
    accounts: readonly TreasuryAccount[],
    field: 'from' | 'to' | 'account',
  ):
    | { status: 'ok'; account: TreasuryAccount }
    | { status: 'rejected'; result: Record<string, unknown> } {
    const resolution = resolveTreasuryAccount(query, accounts);
    if (resolution.status === 'ok') {
      return resolution;
    }
    const ambiguous = resolution.status === 'ambiguous';
    return {
      status: 'rejected',
      result: {
        status: ambiguous ? 'ambiguous_account' : 'account_not_found',
        field,
        requested: query,
        options: (ambiguous ? resolution.matches : accounts).map(describeAccount),
        message: ambiguous
          ? 'Varias cuentas coinciden. NO se preparó nada. Pregunta cuál, con su nombre completo.'
          : 'No existe esa cuenta. NO se preparó nada. Pregunta cuál de las disponibles.',
      },
    };
  }

  /** Saldo actual (las filas ya están bloqueadas por esta transacción). */
  private async readBalance(
    manager: EntityManager,
    company_id: number,
    account: AccountRef,
  ): Promise<number> {
    const [row] = await manager.query<Array<{ balance: string }>>(LOCK_BALANCE_SQL[account.kind], [
      String(account.ref_id),
      String(company_id),
    ]);
    return money(row?.balance ?? '0');
  }

  /**
   * Guarda la pendiente (reemplazando la anterior del usuario). Misma
   * semántica que gastos y pedidos: `one_at_a_time` si esta respuesta ya
   * preparó otra; `concurrent` si otra preparación simultánea ganó.
   */
  private async savePending(
    company_id: number,
    user_id: number,
    action_type: 'TRANSFER_FUNDS' | 'ADJUST_BALANCE',
    payload: TransferPayload | AdjustPayload,
    context: AiToolRequestContext,
  ): Promise<'saved' | 'one_at_a_time' | 'concurrent'> {
    try {
      const rows = await this.dataSource.query<Array<{ id: string }>>(UPSERT_PENDING_ACTION_SQL, [
        String(company_id),
        String(user_id),
        action_type,
        JSON.stringify(payload),
        context.request_id,
        hashMessage(context.current_user_message ?? ''),
        PENDING_ACTION_TTL_MINUTES,
      ]);
      return rows.length > 0 ? 'saved' : 'one_at_a_time';
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        return 'concurrent';
      }
      throw error;
    }
  }

  private notSaved(outcome: 'one_at_a_time' | 'concurrent'): Record<string, unknown> {
    return outcome === 'one_at_a_time'
      ? {
          status: 'one_at_a_time',
          message:
            'Ya preparaste otra operación en esta respuesta: se hace UNA a la vez. Esta NO quedó preparada.',
        }
      : {
          status: 'retry',
          message:
            'Se preparó otra operación al mismo tiempo. NO se ejecutó nada. Que lo intente de nuevo.',
        };
  }

  private forbidden(): Record<string, unknown> {
    return {
      status: 'forbidden',
      message: 'Solo el dueño del negocio puede mover o corregir saldos. NO se ejecutó nada.',
    };
  }

  private unavailable(): Record<string, unknown> {
    return {
      status: 'unavailable',
      message: 'Esta operación no está disponible en este momento. NO se ejecutó nada.',
    };
  }
}
