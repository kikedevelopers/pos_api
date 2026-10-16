import { HttpException, Injectable, Logger } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';
import { preciseNumber } from '@/common/utils/precision';
import { CreateExpenseAction } from '@/modules/expenses/actions/create-expense.action';
import { VoidExpenseAction } from '@/modules/expenses/actions/void-expense.action';
import type { CreateExpenseDto } from '@/modules/expenses/dto/create-expense.dto';
import type { ExpenseSourceType } from '@/modules/expenses/entities/expense.entity';
import { parseUtcRange } from '@/modules/reports/internal/range';

import {
  hashMessage,
  isExplicitConfirmation,
  PENDING_ACTION_TTL_MINUTES,
  readDescriptionArg,
  readMoneyArg,
  resolveExpenseSource,
  type AiToolRequestContext,
  type ExpenseSourceOption,
} from '../internal/expense-tool-helpers';
import {
  buildVoidSearchSql,
  EXPENSE_SOURCES_SQL,
  FIND_EXPENSE_BY_ID_SQL,
  LOCK_EXPENSE_FOR_VOID_SQL,
  LOCK_PENDING_ACTION_SQL,
  MARK_PENDING_EXECUTED_SQL,
  MARK_PENDING_EXPIRED_SQL,
  UPSERT_PENDING_ACTION_SQL,
} from '../internal/expense-tool-sql';
import { readDate, readString } from '../internal/tool-args';
import type { AiToolActor } from '../internal/tool-catalog';

/** Nota de auditoría que queda en el gasto: se registró conversando con Place. */
export const PLACE_EXPENSE_NOTE = 'Registrado con Place (asistente IA)';

type PendingActionType = 'REGISTER_EXPENSE' | 'VOID_EXPENSE';

interface RegisterPayload {
  description: string;
  /** Decimal con 2 cifras ("50000.00"): nunca un float. */
  amount: string;
  source_type: ExpenseSourceType;
  source_id: number;
  source_label: string;
}

interface VoidPayload {
  expense_id: number;
  description: string;
  amount: string;
  source_label: string | null;
  expense_date: string;
}

interface SourceRow {
  source_type: ExpenseSourceType;
  id: string;
  name: string;
  account_number: string | null;
  balance: string;
}

interface ExpenseRow {
  id: string;
  description: string;
  amount: string;
  expense_date: Date;
  source_type: ExpenseSourceType;
  source_name: string | null;
  created_by: string | null;
  is_archived: boolean;
  is_fixed: boolean;
  total_matches?: string;
}

interface PendingRow {
  id: string;
  action_type: PendingActionType;
  payload: RegisterPayload | VoidPayload;
  request_id: string;
  trigger_message_hash: string;
  is_expired: boolean;
}

/**
 * Rechazo de negocio DENTRO de la transacción de confirmación. Se lanza (en vez
 * de devolverse) para que la transacción haga rollback completo.
 */
class ExpenseToolRejection extends Error {
  constructor(
    readonly status: string,
    message: string,
  ) {
    super(message);
  }
}

const money = (value: Big | string): number => preciseNumber(new Big(value), 2);

const SOURCE_KIND_LABEL: Record<ExpenseSourceType, string> = {
  cash_register: 'caja',
  bank: 'banco',
  wallet: 'billetera',
};

const formatLocalDate = (value: Date | string): string =>
  dayjs(value).tz(APP_TIMEZONE).format('YYYY-MM-DD HH:mm');

/** Mensaje legible de una excepción HTTP de las acciones de gastos. */
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

/**
 * Herramientas de ESCRITURA de gastos de Place: registrar y archivar gastos
 * VARIABLES conversando.
 *
 * Flujo (dos turnos, forzado por el servidor — no depende de que el modelo
 * "se porte bien"):
 *
 *   1. `register_expense` / `void_expense` PREPARAN: validan cada dato, resuelven
 *      la cuenta o el gasto exacto y guardan una operación PENDIENTE
 *      (`ai_pending_actions`) con el snapshot de lo que se va a ejecutar. No
 *      mueven un peso.
 *   2. `confirm_expense_action` EJECUTA esa pendiente solo si:
 *        - fue preparada en una petición ANTERIOR (no en la misma respuesta);
 *        - el mensaje del usuario inmediatamente anterior es el que la originó
 *          (el "sí" responde a ESE resumen, no a otro);
 *        - el mensaje actual es un "sí" explícito y nada más;
 *        - no venció (15 min).
 *      Gasto + marca EXECUTED hacen commit en la MISMA transacción, con la
 *      pendiente bloqueada: dos confirmaciones simultáneas no duplican nada.
 *
 * Las escrituras delegan en `CreateExpenseAction` / `VoidExpenseAction`: mismo
 * débito de caja/banco, mismo movimiento financiero y misma alerta que la app.
 */
@Injectable()
export class RunAiExpenseToolAction {
  private readonly logger = new Logger(RunAiExpenseToolAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly createExpense: CreateExpenseAction,
    private readonly voidExpense: VoidExpenseAction,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // register_expense
  // ────────────────────────────────────────────────────────────────────────

  async prepareRegistration(
    company_id: number,
    actor: AiToolActor,
    args: Record<string, unknown>,
    context: AiToolRequestContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (!context?.current_user_message) {
      return this.unavailable();
    }

    const description = readDescriptionArg(args, 'description');
    const amount = readMoneyArg(args, 'amount');
    const source_query = readString(args, 'source');

    const sources = await this.fetchSources(company_id, actor.userId);
    const available_sources = sources.map((source) => this.describeSource(source));

    const missing: string[] = [];
    const invalid: string[] = [];
    if (description.status === 'missing') {
      missing.push('concepto');
    }
    if (description.status === 'invalid') {
      invalid.push(description.reason);
    }
    if (amount.status === 'missing') {
      missing.push('valor');
    }
    if (amount.status === 'invalid') {
      invalid.push(amount.reason);
    }
    if (!source_query) {
      missing.push('de dónde sale el dinero (caja, banco o billetera)');
    }

    if (missing.length > 0 || invalid.length > 0) {
      return {
        status: missing.length > 0 ? 'missing_data' : 'invalid_data',
        missing,
        invalid,
        available_sources,
        message:
          'NO se registró nada. Pregúntale al usuario por los datos faltantes o inválidos (sin suponerlos) y vuelve a llamar con todos.',
      };
    }
    if (description.status !== 'ok' || amount.status !== 'ok' || !source_query) {
      return this.unavailable();
    }

    const resolution = resolveExpenseSource(source_query, sources);
    if (resolution.status === 'not_found') {
      return {
        status: 'source_not_found',
        requested_source: source_query,
        available_sources,
        message: `No existe una cuenta "${source_query}". NO se registró nada. Pregúntale de cuál de las cuentas disponibles sale el dinero.`,
      };
    }
    if (resolution.status === 'ambiguous') {
      return {
        status: 'ambiguous_source',
        requested_source: source_query,
        matches: resolution.matches.map((source) => this.describeSource(source)),
        message:
          'Varias cuentas coinciden. NO se registró nada. Pregúntale cuál de ellas, usando el nombre completo.',
      };
    }

    const source = resolution.source;
    if (amount.amount.gt(source.balance)) {
      return {
        status: 'insufficient_balance',
        source: source.label,
        available_balance: money(source.balance),
        requested_amount: money(amount.amount),
        message: `Saldo insuficiente en ${source.label}. NO se registró nada. Díselo al usuario y pregúntale si sale de otra cuenta.`,
      };
    }

    const payload: RegisterPayload = {
      description: description.description,
      amount: amount.amount.toFixed(2),
      source_type: source.source_type,
      source_id: source.source_id,
      source_label: source.label,
    };
    const saved = await this.savePending(
      company_id,
      actor.userId,
      'REGISTER_EXPENSE',
      payload,
      context,
    );
    if (saved !== 'saved') {
      return this.notSaved(saved);
    }

    return {
      status: 'confirmation_required',
      summary: {
        operation: 'Registrar gasto variable',
        description: payload.description,
        amount: money(payload.amount),
        source: payload.source_label,
        date: dayjs().tz(APP_TIMEZONE).format('YYYY-MM-DD'),
      },
      message:
        'AÚN NO está registrado. Muéstrale al usuario este resumen exacto (concepto, valor y cuenta) y pídele que responda "sí" para registrarlo. Si quiere cambiar algo, vuelve a llamar a register_expense con los datos nuevos.',
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // void_expense
  // ────────────────────────────────────────────────────────────────────────

  async prepareVoid(
    company_id: number,
    actor: AiToolActor,
    args: Record<string, unknown>,
    context: AiToolRequestContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (!context?.current_user_message) {
      return this.unavailable();
    }

    const expense_id = this.readExpenseId(args);
    if (expense_id === 'invalid') {
      return {
        status: 'invalid_data',
        invalid: ['La referencia del gasto no es válida.'],
        message: 'NO se archivó nada. Pídele al usuario la referencia (#) correcta del gasto.',
      };
    }

    let target: ExpenseRow;
    if (expense_id !== null) {
      const rows = await this.dataSource.query<ExpenseRow[]>(FIND_EXPENSE_BY_ID_SQL, [
        String(expense_id),
        String(company_id),
      ]);
      const found = rows[0];
      if (!found) {
        return {
          status: 'not_found',
          message: `No existe el gasto #${expense_id} en este negocio. NO se archivó nada.`,
        };
      }
      if (found.is_archived) {
        return {
          status: 'already_archived',
          expense: this.describeExpense(found),
          message: 'Ese gasto ya está archivado. No hay nada que hacer.',
        };
      }
      if (found.is_fixed) {
        return {
          status: 'fixed_expense',
          expense: this.describeExpense(found),
          message:
            'Ese es el pago de un GASTO FIJO: no se archiva desde aquí sino en el módulo Gastos Fijos. NO se archivó nada.',
        };
      }
      target = found;
    } else {
      const query = readString(args, 'query');
      if (!query) {
        return {
          status: 'missing_data',
          missing: ['concepto del gasto a archivar'],
          message:
            'NO se archivó nada. Pregúntale al usuario el concepto del gasto que quiere archivar.',
        };
      }

      const amount = readMoneyArg(args, 'amount');
      if (amount.status === 'invalid') {
        return {
          status: 'invalid_data',
          invalid: [amount.reason],
          message: 'NO se archivó nada. Confirma con el usuario el valor exacto del gasto.',
        };
      }
      const date = readDate(args, 'date');
      const range = date ? parseUtcRange(date, date) : null;

      const search = buildVoidSearchSql(company_id, {
        query,
        amount: amount.status === 'ok' ? amount.amount.toFixed(2) : null,
        date_range: range ? { start: range.dateStart, end: range.dateEnd } : null,
      });
      const rows = await this.dataSource.query<ExpenseRow[]>(search.sql, search.params);
      const total = Number(rows[0]?.total_matches ?? 0);

      if (rows.length === 0) {
        return {
          status: 'not_found',
          query,
          message:
            'No hay gastos variables activos con ese concepto (y filtros). NO se archivó nada. Díselo al usuario y pregúntale por el concepto exacto o la fecha.',
        };
      }
      if (total > 1) {
        return {
          status: 'multiple_matches',
          total_matches: total,
          candidates: rows.map((row) => this.describeExpense(row)),
          truncated: total > rows.length,
          message:
            'Varios gastos coinciden. NO se archivó nada. Muéstrale la lista con la referencia "#id", fecha, valor y cuenta de cada uno y pregúntale cuál archivar (o pídele la fecha/valor para afinar).',
        };
      }
      target = rows[0];
    }

    const payload: VoidPayload = {
      expense_id: Number(target.id),
      description: target.description,
      amount: new Big(target.amount).toFixed(2),
      source_label: target.source_name,
      expense_date: formatLocalDate(target.expense_date),
    };
    const saved = await this.savePending(
      company_id,
      actor.userId,
      'VOID_EXPENSE',
      payload,
      context,
    );
    if (saved !== 'saved') {
      return this.notSaved(saved);
    }

    return {
      status: 'confirmation_required',
      summary: {
        operation: 'Archivar gasto variable',
        reference: `#${payload.expense_id}`,
        description: payload.description,
        amount: money(payload.amount),
        source: payload.source_label,
        date: payload.expense_date,
        effect: `El valor vuelve a ${payload.source_label ?? 'la cuenta de origen'}.`,
      },
      message:
        'AÚN NO está archivado. Muéstrale al usuario este resumen exacto y pídele que responda "sí" para archivarlo.',
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // confirm_expense_action
  // ────────────────────────────────────────────────────────────────────────

  async confirm(
    company_id: number,
    actor: AiToolActor,
    context: AiToolRequestContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (!context?.current_user_message) {
      return this.unavailable();
    }
    const expense_actor = { id: actor.userId, fullName: actor.full_name?.trim() || 'Usuario' };

    let outcome: Record<string, unknown>;
    let voided = false;
    try {
      outcome = await this.dataSource.transaction(async (manager) => {
        const [pending] = await manager.query<PendingRow[]>(LOCK_PENDING_ACTION_SQL, [
          String(company_id),
          String(actor.userId),
        ]);

        if (!pending) {
          return {
            status: 'no_pending_action',
            message:
              'No hay ninguna operación de gasto pendiente de confirmar. NO se ejecutó nada. Si el usuario quiere registrar o archivar un gasto, prepáralo primero.',
          };
        }

        const expire = async (): Promise<void> => {
          await manager.query(MARK_PENDING_EXPIRED_SQL, [pending.id, String(company_id)]);
        };

        if (pending.request_id === context.request_id) {
          return {
            status: 'awaiting_user_reply',
            message:
              'NO se ejecutó nada: el usuario todavía no ha respondido al resumen. Muéstraselo y espera a que responda "sí".',
          };
        }
        if (pending.is_expired) {
          await expire();
          return {
            status: 'expired',
            message:
              'La operación preparada venció sin confirmarse. NO se ejecutó nada. Vuelve a prepararla y pide confirmación de nuevo.',
          };
        }
        if (
          context.previous_user_message === null ||
          hashMessage(context.previous_user_message) !== pending.trigger_message_hash
        ) {
          await expire();
          return {
            status: 'stale_confirmation',
            message:
              'La respuesta del usuario no corresponde al último resumen que se le mostró. NO se ejecutó nada. Vuelve a preparar la operación, muéstrale el resumen y pide su "sí".',
          };
        }
        if (!isExplicitConfirmation(context.current_user_message)) {
          await expire();
          return {
            status: 'confirmation_not_explicit',
            message:
              'El usuario no respondió con un "sí" explícito (cambió algo, dijo que no o preguntó otra cosa). NO se ejecutó nada. Si cambió datos, prepara de nuevo con los datos nuevos; si no, pregúntale si confirma.',
          };
        }

        if (pending.action_type === 'REGISTER_EXPENSE') {
          const payload = pending.payload as RegisterPayload;
          const dto = {
            description: payload.description,
            amount: Number(payload.amount),
            source_type: payload.source_type,
            source_id: payload.source_id,
            notes: PLACE_EXPENSE_NOTE,
          } as CreateExpenseDto;
          const expense = await this.createExpense.runInTransaction(
            manager,
            dto,
            company_id,
            expense_actor,
          );
          await manager.query(MARK_PENDING_EXECUTED_SQL, [
            pending.id,
            String(company_id),
            String(expense.id),
          ]);
          this.logger.log({
            event: 'ai.expense.registered',
            companyId: company_id,
            userId: actor.userId,
            pendingActionId: Number(pending.id),
            expenseId: Number(expense.id),
          });
          return {
            status: 'executed',
            operation: 'register',
            expense: {
              reference: `#${String(expense.id)}`,
              description: expense.description,
              amount: money(String(expense.amount)),
              source: expense.source_name,
            },
            message: 'Gasto registrado. Confírmale al usuario los datos exactos que quedaron.',
          };
        }

        const payload = pending.payload as VoidPayload;
        const [current] = await manager.query<ExpenseRow[]>(LOCK_EXPENSE_FOR_VOID_SQL, [
          String(payload.expense_id),
          String(company_id),
        ]);
        if (!current) {
          throw new ExpenseToolRejection('failed', 'El gasto ya no existe. NO se archivó nada.');
        }
        if (current.is_archived) {
          throw new ExpenseToolRejection(
            'already_archived',
            'Ese gasto ya había sido archivado (quizá desde otra pantalla). NO se hizo nada.',
          );
        }
        if (
          current.is_fixed ||
          current.description !== payload.description ||
          !new Big(current.amount).eq(payload.amount)
        ) {
          throw new ExpenseToolRejection(
            'failed',
            'El gasto cambió desde que se mostró el resumen. NO se archivó nada. Vuelve a prepararlo.',
          );
        }

        await this.voidExpense.runInTransaction(
          manager,
          payload.expense_id,
          company_id,
          expense_actor,
        );
        await manager.query(MARK_PENDING_EXECUTED_SQL, [
          pending.id,
          String(company_id),
          String(payload.expense_id),
        ]);
        voided = true;
        this.logger.log({
          event: 'ai.expense.voided',
          companyId: company_id,
          userId: actor.userId,
          pendingActionId: Number(pending.id),
          expenseId: payload.expense_id,
        });
        return {
          status: 'executed',
          operation: 'void',
          expense: {
            reference: `#${payload.expense_id}`,
            description: payload.description,
            amount: money(payload.amount),
            source: payload.source_label,
          },
          message: `Gasto archivado: el valor volvió a ${payload.source_label ?? 'su cuenta de origen'}. Confírmaselo al usuario.`,
        };
      });
    } catch (error) {
      // Rollback completo: ni gasto, ni movimiento, ni pendiente ejecutada.
      if (error instanceof ExpenseToolRejection) {
        return { status: error.status, message: error.message };
      }
      if (error instanceof HttpException) {
        return {
          status: 'failed',
          message: `NO se ejecutó: ${httpErrorMessage(error)}. Explícaselo al usuario.`,
        };
      }
      throw error;
    }

    if (voided) {
      this.voidExpense.notifyVoided(company_id);
    }
    return outcome;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internos
  // ────────────────────────────────────────────────────────────────────────

  private async fetchSources(company_id: number, user_id: number): Promise<ExpenseSourceOption[]> {
    const rows = await this.dataSource.query<SourceRow[]>(EXPENSE_SOURCES_SQL, [
      String(company_id),
      String(user_id),
    ]);
    const options: ExpenseSourceOption[] = rows.map((row) => ({
      source_type: row.source_type,
      source_id: Number(row.id),
      label:
        row.source_type === 'bank' && row.account_number
          ? `${row.name} - ${row.account_number}`
          : row.name,
      name: row.name,
      account_number: row.account_number,
      balance: new Big(row.balance ?? 0),
    }));
    // La caja del actor existe aunque nunca la haya usado: `CreateExpenseAction`
    // la crea al registrar. Sin fila, su saldo es 0.
    if (!options.some((option) => option.source_type === 'cash_register')) {
      options.unshift({
        source_type: 'cash_register',
        source_id: 0,
        label: 'Caja',
        name: 'Caja',
        account_number: null,
        balance: new Big(0),
      });
    }
    return options;
  }

  private describeSource(source: ExpenseSourceOption): Record<string, unknown> {
    return {
      name: source.label,
      kind: SOURCE_KIND_LABEL[source.source_type],
      balance: money(source.balance),
    };
  }

  private describeExpense(row: ExpenseRow): Record<string, unknown> {
    return {
      reference: `#${row.id}`,
      expense_id: Number(row.id),
      description: row.description,
      amount: money(row.amount),
      date: formatLocalDate(row.expense_date),
      source: row.source_name,
      registered_by: row.created_by,
    };
  }

  /** `null` = no vino; `'invalid'` = vino pero no es un id entero positivo. */
  private readExpenseId(args: Record<string, unknown>): number | null | 'invalid' {
    const raw = args?.expense_id;
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
    const cleaned = text.trim().replace(/^#/, '');
    if (
      !/^\d{1,18}$/.test(cleaned) ||
      Number(cleaned) <= 0 ||
      !Number.isSafeInteger(Number(cleaned))
    ) {
      return 'invalid';
    }
    return Number(cleaned);
  }

  /**
   * Guarda la pendiente (reemplazando la anterior del usuario).
   *   - `saved`: lista para el "sí".
   *   - `one_at_a_time`: esta misma respuesta ya preparó otra operación.
   *   - `concurrent`: otra preparación simultánea del mismo usuario ganó la
   *     carrera (23505 del índice único parcial).
   */
  private async savePending(
    company_id: number,
    user_id: number,
    action_type: PendingActionType,
    payload: RegisterPayload | VoidPayload,
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
    if (outcome === 'one_at_a_time') {
      return {
        status: 'one_at_a_time',
        message:
          'Ya preparaste otra operación de gasto en esta misma respuesta: se hace UNA a la vez. Esta NO quedó preparada. Muestra el primer resumen, espera el "sí" y después prepara la siguiente.',
      };
    }
    return {
      status: 'retry',
      message:
        'Se preparó otra operación al mismo tiempo. NO se ejecutó nada. Pídele al usuario que lo intente de nuevo.',
    };
  }

  private unavailable(): Record<string, unknown> {
    return {
      status: 'unavailable',
      message: 'Esta operación no está disponible en este momento. NO se ejecutó nada.',
    };
  }
}
