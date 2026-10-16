import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { ResolveAiActorAction } from '@/modules/ai/actions/resolve-ai-actor.action';
import {
  PLACE_EXPENSE_NOTE,
  RunAiExpenseToolAction,
} from '@/modules/ai/actions/run-ai-expense-tool.action';
import type { AiToolRequestContext } from '@/modules/ai/internal/expense-tool-helpers';
import type { AiToolActor } from '@/modules/ai/internal/tool-catalog';
import { CreateExpenseAction } from '@/modules/expenses/actions/create-expense.action';
import { VoidExpenseAction } from '@/modules/expenses/actions/void-expense.action';
import { ListFinancialMovementsAction } from '@/modules/financial-movements/actions/list-financial-movements.action';
import { RecordFinancialMovementAction } from '@/modules/financial-movements/actions/record-financial-movement.action';
import { FinancialMovement } from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import type { RealtimeGateway } from '@/modules/realtime/realtime.gateway';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import { seedSystemRolesForCompany } from '@/modules/roles/internal/system-roles';

import {
  cleanupCompany,
  createDisposableCompany,
  insertOwnerUser,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL pos_db) — Place registra y archiva gastos variables.
 *
 * Lo que se fija aquí (lo que NO puede fallar):
 *   - Nada se escribe sin los 3 datos (concepto, valor, fuente) ni sin un "sí"
 *     explícito en un turno POSTERIOR que responda a ESE resumen.
 *   - Lo ejecutado es EXACTAMENTE lo preparado (concepto, valor, cuenta / el
 *     gasto exacto), con los mismos efectos que la app: saldo, log de caja,
 *     movimiento financiero, alerta de anulación.
 *   - Exactamente una vez: confirmaciones repetidas o simultáneas no duplican.
 *   - Aislamiento: la pendiente de un usuario no la confirma otro.
 *   - Solo gastos VARIABLES activos de la company.
 *   - Owner y rol Administrador escriben; Cajero/Vendedor no.
 */

const COMPANY = '__E2E_AI_EXPENSE_TOOLS__';
const OTHER_COMPANY = '__E2E_AI_EXPENSE_TOOLS_OTHER__';
const CASH_START = 300000;
const BANK_START = 1000000;
const WALLET_START = 200000;

const canConnectPromise = tryInitDataSource();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Place · herramientas de gastos (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let cid = 0;
  let otherCid = 0;
  let ownerId = 0;
  let adminEmployeeUserId = 0;
  let registerId = '';
  let bankId = '';
  let walletId = '';
  let emitAlertCreated: jest.Mock;
  let tools: RunAiExpenseToolAction;
  let voidAction: VoidExpenseAction;
  let owner: AiToolActor;
  let adminEmployee: AiToolActor;

  const db = (): DataSource => {
    if (!ds) {
      throw new Error('Sin BD');
    }
    return ds;
  };
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    db().query(sql, params);

  const ctx = (
    current: string,
    previous: string | null = null,
    request_id: string = randomUUID(),
  ): AiToolRequestContext => ({
    request_id,
    current_user_message: current,
    previous_user_message: previous,
  });

  const balance = async (
    table: 'cash_registers' | 'banks' | 'wallets',
    id: string,
  ): Promise<number> =>
    Number((await q<{ b: string }>(`SELECT balance AS b FROM ${table} WHERE id = $1`, [id]))[0].b);

  const pendingRows = (
    user_id = ownerId,
  ): Promise<
    Array<{
      status: string;
      payload: { expense_id?: number; description?: string };
      result_ref: string | null;
    }>
  > =>
    q(
      `SELECT status, payload, result_ref FROM ai_pending_actions
        WHERE company_id = $1 AND user_id = $2 ORDER BY id`,
      [String(cid), String(user_id)],
    );

  const expenseCount = async (): Promise<number> =>
    Number(
      (
        await q<{ n: string }>(`SELECT count(*) AS n FROM expenses WHERE company_id = $1`, [
          String(cid),
        ])
      )[0].n,
    );

  const insertExpense = async (o: {
    description: string;
    amount: number;
    company?: number;
    is_fixed?: boolean;
    is_archived?: boolean;
    date?: string;
  }): Promise<string> => {
    const [row] = await q<{ id: string }>(
      `INSERT INTO expenses (company_id, description, amount, source_type, source_id, source_name,
                             expense_date, is_fixed, is_archived, created_by, created_by_id)
       VALUES ($1, $2, $3, 'cash_register', $4, 'Caja', COALESCE($5::timestamptz, now()), $6, $7, 'E2E Owner', $8)
       RETURNING id`,
      [
        String(o.company ?? cid),
        o.description,
        o.amount,
        registerId,
        o.date ?? null,
        o.is_fixed ?? false,
        o.is_archived ?? false,
        String(ownerId),
      ],
    );
    return row.id;
  };

  /** Prepara con `prepare` y confirma con "sí" en la petición siguiente. */
  const prepareAndConfirm = async (
    prepare: (context: AiToolRequestContext) => Promise<Record<string, unknown>>,
    trigger: string,
    actor: AiToolActor = owner,
  ): Promise<{ prepared: Record<string, unknown>; confirmed: Record<string, unknown> }> => {
    const prepared = await prepare(ctx(trigger));
    const confirmed = await tools.confirm(cid, actor, ctx('sí', trigger));
    return { prepared, confirmed };
  };

  beforeAll(async () => {
    ds = await canConnectPromise;
    if (!ds) {
      return;
    }
    cid = await createDisposableCompany(ds, COMPANY);
    otherCid = await createDisposableCompany(ds, OTHER_COMPANY);
    await seedSystemRolesForCompany(ds.manager, cid);
    ownerId = await insertOwnerUser(ds, cid, 'ai_expenses');

    registerId = (
      await q<{ id: string }>(
        `INSERT INTO cash_registers (company_id, user_id, balance) VALUES ($1, $2, $3) RETURNING id`,
        [String(cid), String(ownerId), CASH_START],
      )
    )[0].id;
    bankId = (
      await q<{ id: string }>(
        `INSERT INTO banks (company_id, name, account_number, balance) VALUES ($1, 'BANCOLOMBIA', '123', $2) RETURNING id`,
        [String(cid), BANK_START],
      )
    )[0].id;
    walletId = (
      await q<{ id: string }>(
        `INSERT INTO wallets (company_id, name, balance) VALUES ($1, 'Nequi', $2) RETURNING id`,
        [String(cid), WALLET_START],
      )
    )[0].id;

    adminEmployeeUserId = Number(
      (
        await q<{ id: string }>(
          `INSERT INTO users (name, lastname, email, password, type, company_id)
           VALUES ('Ana', 'Admin', $1, 'x', 'employee', $2) RETURNING id`,
          [`__e2e_ai_admin_${Date.now()}@example.test`, String(cid)],
        )
      )[0].id,
    );

    const financial = new FinancialMovementsService(
      new ListFinancialMovementsAction(ds.getRepository(FinancialMovement)),
      new RecordFinancialMovementAction(),
    );
    emitAlertCreated = jest.fn();
    voidAction = new VoidExpenseAction(ds, financial, {
      emitAlertCreated,
    } as unknown as RealtimeGateway);
    tools = new RunAiExpenseToolAction(ds, new CreateExpenseAction(ds, financial), voidAction);

    owner = {
      isAdmin: true,
      permissions: new Set<string>(),
      canViewProfit: true,
      userId: ownerId,
      is_administrator: true,
      full_name: 'E2E Owner',
    };
    adminEmployee = {
      isAdmin: false,
      permissions: new Set<string>(['canAccessExpenses']),
      canViewProfit: false,
      userId: adminEmployeeUserId,
      is_administrator: true,
      full_name: 'Ana Admin',
    };
  });

  afterAll(async () => {
    if (ds) {
      await q(`DELETE FROM employees WHERE company_id = $1`, [String(cid)]);
      await cleanupCompany(ds, cid);
      await cleanupCompany(ds, otherCid);
      await ds.destroy();
    }
  });

  beforeEach(async () => {
    if (!ds) {
      return;
    }
    await q(`DELETE FROM ai_pending_actions WHERE company_id = $1`, [String(cid)]);
    await q(`DELETE FROM app_alerts WHERE company_id = $1`, [String(cid)]);
    await q(`DELETE FROM financial_movements WHERE company_id = $1`, [String(cid)]);
    await q(`DELETE FROM cash_register_logs WHERE company_id = $1`, [String(cid)]);
    await q(`DELETE FROM expenses WHERE company_id = $1`, [String(cid)]);
    await q(`UPDATE cash_registers SET balance = $2 WHERE id = $1`, [registerId, CASH_START]);
    await q(`UPDATE banks SET balance = $2 WHERE id = $1`, [bankId, BANK_START]);
    await q(`UPDATE wallets SET balance = $2 WHERE id = $1`, [walletId, WALLET_START]);
    emitAlertCreated.mockClear();
  });

  const itDb = (name: string, fn: () => Promise<void>): void => {
    it(name, async () => {
      if (!(await canConnectPromise)) {
        return; // sin BD en el runner: se omite limpio.
      }
      await fn();
    });
  };

  // ────────────────────────────────────────────────────────────────────────
  // register_expense — preparación
  // ────────────────────────────────────────────────────────────────────────

  describe('register_expense · nunca registra en blanco', () => {
    itDb('sin ningún dato pide los 3 y lista las cuentas reales', async () => {
      const result = await tools.prepareRegistration(cid, owner, {}, ctx('registra un gasto'));

      expect(result.status).toBe('missing_data');
      expect(result.missing).toEqual([
        'concepto',
        'valor',
        'de dónde sale el dinero (caja, banco o billetera)',
      ]);
      expect(result.available_sources).toEqual(
        expect.arrayContaining([
          { name: 'Caja', kind: 'caja', balance: CASH_START },
          { name: 'BANCOLOMBIA - 123', kind: 'banco', balance: BANK_START },
          { name: 'Nequi', kind: 'billetera', balance: WALLET_START },
        ]),
      );
      expect(await pendingRows()).toEqual([]);
    });

    itDb(
      'con concepto y valor pero SIN fuente: pregunta la fuente (no asume la caja)',
      async () => {
        const result = await tools.prepareRegistration(
          cid,
          owner,
          { description: 'Pago de luz', amount: 50000 },
          ctx('registra 50 mil de luz'),
        );
        expect(result.status).toBe('missing_data');
        expect(result.missing).toEqual(['de dónde sale el dinero (caja, banco o billetera)']);
        expect(await pendingRows()).toEqual([]);
      },
    );

    itDb('concepto de relleno ("gasto") cuenta como faltante', async () => {
      const result = await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Gasto', amount: 50000, source: 'caja' },
        ctx('registra un gasto de 50 mil desde caja'),
      );
      expect(result.status).toBe('missing_data');
      expect(result.missing).toEqual(['concepto']);
    });

    itDb('"50.000" como string se rechaza (no se registra 50 pesos)', async () => {
      const result = await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Luz', amount: '50.000', source: 'caja' },
        ctx('registra 50.000 de luz desde caja'),
      );
      expect(result.status).toBe('invalid_data');
      expect(await pendingRows()).toEqual([]);
    });

    itDb('cuenta inexistente → source_not_found con las disponibles', async () => {
      const result = await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Luz', amount: 50000, source: 'Davivienda' },
        ctx('registra 50000 de luz desde Davivienda'),
      );
      expect(result.status).toBe('source_not_found');
      expect((result.available_sources as unknown[]).length).toBe(3);
      expect(await pendingRows()).toEqual([]);
    });

    itDb('saldo insuficiente en la cuenta → no prepara nada', async () => {
      const result = await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Nevera', amount: CASH_START + 1, source: 'caja' },
        ctx('registra la nevera desde caja'),
      );
      expect(result).toMatchObject({
        status: 'insufficient_balance',
        source: 'Caja',
        available_balance: CASH_START,
      });
      expect(await pendingRows()).toEqual([]);
    });

    itDb('sin contexto de la petición se niega (fail-closed)', async () => {
      const result = await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Luz', amount: 1, source: 'caja' },
        undefined,
      );
      expect(result.status).toBe('unavailable');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // register_expense — confirmación
  // ────────────────────────────────────────────────────────────────────────

  describe('register_expense + confirm · ejecuta EXACTAMENTE lo preparado', () => {
    itDb('desde la caja: mismo gasto, mismo débito y log que la app', async () => {
      const trigger =
        'Registrar un gasto de 45 mil bajo el concepto de Almuerzo equipo, de la caja';
      const prepared = await tools.prepareRegistration(
        cid,
        owner,
        { description: '  Almuerzo   equipo ', amount: 45000, source: 'de la caja' },
        ctx(trigger, null, 'aaaaaaaa-0000-4000-8000-000000000001'),
      );
      expect(prepared.status).toBe('confirmation_required');
      expect(prepared.summary).toMatchObject({
        description: 'Almuerzo equipo',
        amount: 45000,
        source: 'Caja',
      });
      // Preparar NO mueve dinero.
      expect(await expenseCount()).toBe(0);
      expect(await balance('cash_registers', registerId)).toBe(CASH_START);

      // El modelo intenta confirmar en la MISMA petición → rechazado.
      const sameTurn = await tools.confirm(
        cid,
        owner,
        ctx(trigger, null, 'aaaaaaaa-0000-4000-8000-000000000001'),
      );
      expect(sameTurn.status).toBe('awaiting_user_reply');
      expect(await expenseCount()).toBe(0);

      // El usuario responde "Sí, por favor" en la petición siguiente.
      const confirmed = await tools.confirm(cid, owner, ctx('Sí, por favor', trigger));
      expect(confirmed).toMatchObject({
        status: 'executed',
        operation: 'register',
        expense: { description: 'Almuerzo equipo', amount: 45000, source: 'Caja' },
      });

      const [expense] = await q<Record<string, string | boolean>>(
        `SELECT id, description, amount, source_type, source_id, source_name, notes, is_fixed,
                is_archived, created_by, created_by_id
           FROM expenses WHERE company_id = $1`,
        [String(cid)],
      );
      expect(expense).toMatchObject({
        description: 'Almuerzo equipo',
        amount: '45000.00',
        source_type: 'cash_register',
        source_id: registerId,
        source_name: 'Caja',
        notes: PLACE_EXPENSE_NOTE,
        is_fixed: false,
        is_archived: false,
        created_by: 'E2E Owner',
        created_by_id: String(ownerId),
      });
      expect(await balance('cash_registers', registerId)).toBe(CASH_START - 45000);
      const logs = await q<{ type: string; direction: string; amount: string }>(
        `SELECT type, direction, amount FROM cash_register_logs WHERE company_id = $1`,
        [String(cid)],
      );
      expect(logs).toEqual([{ type: 'EXPENSE', direction: 'OUT', amount: '45000.00' }]);

      const [pending] = await pendingRows();
      expect(pending.status).toBe('EXECUTED');
      expect(pending.result_ref).toBe(String(expense.id));

      // Un segundo "sí" no vuelve a registrar.
      const again = await tools.confirm(cid, owner, ctx('sí', trigger));
      expect(again.status).toBe('no_pending_action');
      expect(await expenseCount()).toBe(1);
      expect(await balance('cash_registers', registerId)).toBe(CASH_START - 45000);
    });

    itDb('desde un banco: debita el banco y registra el movimiento financiero', async () => {
      const { confirmed } = await prepareAndConfirm(
        (context) =>
          tools.prepareRegistration(
            cid,
            owner,
            { description: 'Pago de internet', amount: 120000.5, source: 'Bancolombia' },
            context,
          ),
        'registra 120000.50 de internet desde Bancolombia',
      );
      expect(confirmed.status).toBe('executed');
      expect(await balance('banks', bankId)).toBe(BANK_START - 120000.5);
      expect(await balance('cash_registers', registerId)).toBe(CASH_START);

      const movements = await q<{ movement_type: string; amount: string; reference_code: string }>(
        `SELECT movement_type, amount, reference_code FROM financial_movements WHERE company_id = $1`,
        [String(cid)],
      );
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ movement_type: 'EXPENSE', amount: '120000.50' });
      expect(movements[0].reference_code).toMatch(/^EXP-\d+$/);
    });

    itDb('"sí, pero de 60 mil" NO confirma: no registra y la pendiente muere', async () => {
      const trigger = 'registra 50000 de luz desde Nequi';
      await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Luz', amount: 50000, source: 'Nequi' },
        ctx(trigger),
      );
      const result = await tools.confirm(cid, owner, ctx('sí, pero de 60 mil', trigger));

      expect(result.status).toBe('confirmation_not_explicit');
      expect(await expenseCount()).toBe(0);
      expect(await balance('wallets', walletId)).toBe(WALLET_START);
      expect((await pendingRows()).map((row) => row.status)).toEqual(['EXPIRED']);
      // Y un "sí" posterior ya no la revive.
      const late = await tools.confirm(cid, owner, ctx('sí', 'sí, pero de 60 mil'));
      expect(late.status).toBe('no_pending_action');
    });

    itDb('un "sí" que no responde a ESE resumen no ejecuta (stale)', async () => {
      await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Luz', amount: 50000, source: 'caja' },
        ctx('registra 50000 de luz desde caja'),
      );
      const result = await tools.confirm(cid, owner, ctx('sí', '¿cuánto vendí hoy?'));
      expect(result.status).toBe('stale_confirmation');
      expect(await expenseCount()).toBe(0);
      expect((await pendingRows())[0].status).toBe('EXPIRED');
    });

    itDb('sin mensaje anterior (dos mensajes seguidos del usuario) no ejecuta', async () => {
      await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Luz', amount: 50000, source: 'caja' },
        ctx('registra 50000 de luz desde caja'),
      );
      const result = await tools.confirm(cid, owner, ctx('sí', null));
      expect(result.status).toBe('stale_confirmation');
      expect(await expenseCount()).toBe(0);
    });

    itDb('una nueva preparación reemplaza la anterior; se ejecuta solo la última', async () => {
      await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Luz', amount: 50000, source: 'caja' },
        ctx('registra 50000 de luz desde caja'),
      );
      const trigger = 'no, mejor 60000';
      await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Luz', amount: 60000, source: 'caja' },
        ctx(trigger),
      );
      expect((await pendingRows()).map((row) => row.status)).toEqual(['SUPERSEDED', 'PENDING']);

      const result = await tools.confirm(cid, owner, ctx('sí', trigger));
      expect(result).toMatchObject({ status: 'executed', expense: { amount: 60000 } });
      expect(await expenseCount()).toBe(1);
      expect(await balance('cash_registers', registerId)).toBe(CASH_START - 60000);
    });

    itDb(
      'dos preparaciones en la MISMA respuesta: la segunda se rechaza, la primera sigue',
      async () => {
        const trigger = 'registra 10000 de pan y 20000 de leche desde caja';
        const request_id = randomUUID();
        const first = await tools.prepareRegistration(
          cid,
          owner,
          { description: 'Pan', amount: 10000, source: 'caja' },
          ctx(trigger, null, request_id),
        );
        const second = await tools.prepareRegistration(
          cid,
          owner,
          { description: 'Leche', amount: 20000, source: 'caja' },
          ctx(trigger, null, request_id),
        );
        expect(first.status).toBe('confirmation_required');
        expect(second.status).toBe('one_at_a_time');
        const rows = await pendingRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'PENDING', payload: { description: 'Pan' } });

        const result = await tools.confirm(cid, owner, ctx('sí', trigger));
        expect(result).toMatchObject({ status: 'executed', expense: { description: 'Pan' } });
        expect(await expenseCount()).toBe(1);
      },
    );

    itDb('vencida (15 min) no se ejecuta', async () => {
      const trigger = 'registra 50000 de luz desde caja';
      await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Luz', amount: 50000, source: 'caja' },
        ctx(trigger),
      );
      await q(
        `UPDATE ai_pending_actions SET expires_at = now() - interval '1 minute' WHERE company_id = $1`,
        [String(cid)],
      );
      const result = await tools.confirm(cid, owner, ctx('sí', trigger));
      expect(result.status).toBe('expired');
      expect(await expenseCount()).toBe(0);
    });

    itDb('la pendiente de un usuario NO la confirma otro (aislamiento)', async () => {
      const trigger = 'registra 50000 de luz desde caja';
      await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Luz', amount: 50000, source: 'caja' },
        ctx(trigger),
      );
      const result = await tools.confirm(cid, adminEmployee, ctx('sí', trigger));
      expect(result.status).toBe('no_pending_action');
      expect(await expenseCount()).toBe(0);
      expect((await pendingRows())[0].status).toBe('PENDING');
    });

    itDb('dos "sí" SIMULTÁNEOS registran UNA sola vez', async () => {
      const trigger = 'registra 30000 de papelería desde caja';
      await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Papelería', amount: 30000, source: 'caja' },
        ctx(trigger),
      );
      // Otra conexión retiene la fila pendiente: los 3 "sí" arrancan a la vez y
      // quedan en carrera real. Sin el FOR UPDATE de la pendiente, los tres la
      // leerían PENDING y registrarían el gasto tres veces.
      const holder = db().createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      await holder.query(
        `SELECT id FROM ai_pending_actions WHERE company_id = $1 AND status = 'PENDING' FOR UPDATE`,
        [String(cid)],
      );
      const racing = Promise.all([
        tools.confirm(cid, owner, ctx('sí', trigger)),
        tools.confirm(cid, owner, ctx('sí', trigger)),
        tools.confirm(cid, owner, ctx('dale', trigger)),
      ]);
      await sleep(250);
      await holder.commitTransaction();
      await holder.release();
      const results = await racing;
      expect(results.filter((r) => r.status === 'executed')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'no_pending_action')).toHaveLength(2);
      expect(await expenseCount()).toBe(1);
      expect(await balance('cash_registers', registerId)).toBe(CASH_START - 30000);
    });

    itDb('si el saldo cambió antes del "sí", falla con rollback total', async () => {
      const trigger = 'registra 250000 de mercancía desde caja';
      await tools.prepareRegistration(
        cid,
        owner,
        { description: 'Mercancía', amount: 250000, source: 'caja' },
        ctx(trigger),
      );
      await q(`UPDATE cash_registers SET balance = 1000 WHERE id = $1`, [registerId]);

      const result = await tools.confirm(cid, owner, ctx('sí', trigger));
      expect(result.status).toBe('failed');
      expect(String(result.message)).toMatch(/Saldo insuficiente/);
      expect(await expenseCount()).toBe(0);
      expect(await balance('cash_registers', registerId)).toBe(1000);
      // Rollback: la pendiente no quedó como ejecutada.
      expect((await pendingRows())[0].status).toBe('PENDING');
    });

    itDb('el empleado Administrador registra desde SU caja (no la del owner)', async () => {
      const { confirmed } = await prepareAndConfirm(
        (context) =>
          tools.prepareRegistration(
            cid,
            adminEmployee,
            { description: 'Domicilio', amount: 8000, source: 'Nequi' },
            context,
          ),
        'registra 8000 de domicilio desde nequi',
        adminEmployee,
      );
      expect(confirmed.status).toBe('executed');
      expect(await balance('wallets', walletId)).toBe(WALLET_START - 8000);
      const [row] = await q<{ created_by: string; created_by_id: string }>(
        `SELECT created_by, created_by_id FROM expenses WHERE company_id = $1`,
        [String(cid)],
      );
      expect(row).toEqual({ created_by: 'Ana Admin', created_by_id: String(adminEmployeeUserId) });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // void_expense
  // ────────────────────────────────────────────────────────────────────────

  describe('void_expense · encuentra el gasto EXACTO', () => {
    itDb('un único match por concepto (sin tildes) → resumen con referencia', async () => {
      const id = await insertExpense({ description: 'Pago de luz', amount: 80000 });
      const result = await tools.prepareVoid(
        cid,
        owner,
        { query: 'pago de LÚZ' },
        ctx('elimina el gasto de luz'),
      );
      expect(result).toMatchObject({
        status: 'confirmation_required',
        summary: { reference: `#${id}`, description: 'Pago de luz', amount: 80000, source: 'Caja' },
      });
      expect((await pendingRows())[0].payload.expense_id).toBe(Number(id));
    });

    itDb('varios matches → lista para elegir, sin preparar nada; se afina por valor', async () => {
      const a = await insertExpense({ description: 'Almuerzo', amount: 10000 });
      const b = await insertExpense({ description: 'Almuerzo equipo', amount: 12000 });
      const result = await tools.prepareVoid(
        cid,
        owner,
        { query: 'almuerzo' },
        ctx('elimina el almuerzo'),
      );

      expect(result.status).toBe('multiple_matches');
      expect(result.total_matches).toBe(2);
      const refs = (result.candidates as Array<{ reference: string }>).map((c) => c.reference);
      // La coincidencia exacta va primero.
      expect(refs).toEqual([`#${a}`, `#${b}`]);
      expect(await pendingRows()).toEqual([]);

      const narrowed = await tools.prepareVoid(
        cid,
        owner,
        { query: 'almuerzo', amount: 12000 },
        ctx('el de 12 mil'),
      );
      expect(narrowed).toMatchObject({
        status: 'confirmation_required',
        summary: { reference: `#${b}` },
      });
    });

    itDb('filtra por día (hora Colombia)', async () => {
      await insertExpense({ description: 'Taxi', amount: 15000, date: '2026-10-01T15:00:00Z' });
      const target = await insertExpense({
        description: 'Taxi',
        amount: 15000,
        date: '2026-10-02T15:00:00Z',
      });
      const result = await tools.prepareVoid(
        cid,
        owner,
        { query: 'taxi', date: '2026-10-02' },
        ctx('elimina el taxi del 2 de octubre'),
      );
      expect(result).toMatchObject({
        status: 'confirmation_required',
        summary: { reference: `#${target}` },
      });
    });

    itDb('NUNCA ofrece gastos fijos, archivados ni de otra company', async () => {
      const fixed = await insertExpense({
        description: 'Arriendo',
        amount: 900000,
        is_fixed: true,
      });
      const archived = await insertExpense({
        description: 'Arriendo bodega',
        amount: 5000,
        is_archived: true,
      });
      const foreign = await insertExpense({
        description: 'Arriendo',
        amount: 1000,
        company: otherCid,
      });

      const byQuery = await tools.prepareVoid(
        cid,
        owner,
        { query: 'arriendo' },
        ctx('elimina el arriendo'),
      );
      expect(byQuery.status).toBe('not_found');

      expect(
        (await tools.prepareVoid(cid, owner, { expense_id: Number(fixed) }, ctx('el #'))).status,
      ).toBe('fixed_expense');
      expect(
        (await tools.prepareVoid(cid, owner, { expense_id: `#${archived}` }, ctx('el #'))).status,
      ).toBe('already_archived');
      expect(
        (await tools.prepareVoid(cid, owner, { expense_id: Number(foreign) }, ctx('el #'))).status,
      ).toBe('not_found');
      expect(await pendingRows()).toEqual([]);
    });

    itDb('los comodines del usuario son literales ("%" no lo encuentra todo)', async () => {
      await insertExpense({ description: 'Luz', amount: 1000 });
      const result = await tools.prepareVoid(cid, owner, { query: '%' }, ctx('elimina %'));
      expect(result.status).toBe('not_found');
    });

    itDb('sin concepto ni referencia pide el dato; referencia basura se rechaza', async () => {
      expect((await tools.prepareVoid(cid, owner, {}, ctx('elimina un gasto'))).status).toBe(
        'missing_data',
      );
      expect((await tools.prepareVoid(cid, owner, { expense_id: 'abc' }, ctx('x'))).status).toBe(
        'invalid_data',
      );
      expect((await tools.prepareVoid(cid, owner, { expense_id: -4 }, ctx('x'))).status).toBe(
        'invalid_data',
      );
    });

    itDb('confirmar devuelve el dinero, archiva, alerta y avisa en tiempo real', async () => {
      const id = await insertExpense({ description: 'Pago de luz', amount: 80000 });
      await q(`UPDATE cash_registers SET balance = $2 WHERE id = $1`, [
        registerId,
        CASH_START - 80000,
      ]);

      const { prepared, confirmed } = await prepareAndConfirm(
        (context) => tools.prepareVoid(cid, owner, { query: 'luz' }, context),
        'Elimina el gasto por concepto luz',
      );
      expect(prepared.status).toBe('confirmation_required');
      expect(confirmed).toMatchObject({
        status: 'executed',
        operation: 'void',
        expense: { reference: `#${id}` },
      });

      const [row] = await q<{ is_archived: boolean }>(
        `SELECT is_archived FROM expenses WHERE id = $1`,
        [id],
      );
      expect(row.is_archived).toBe(true);
      expect(await balance('cash_registers', registerId)).toBe(CASH_START);
      const alerts = await q<{ type: string }>(
        `SELECT type FROM app_alerts WHERE company_id = $1`,
        [String(cid)],
      );
      expect(alerts).toEqual([{ type: 'EXPENSE_VOIDED' }]);
      expect(emitAlertCreated).toHaveBeenCalledTimes(1);
      expect((await pendingRows())[0]).toMatchObject({ status: 'EXECUTED', result_ref: id });
    });

    itDb(
      'si lo anularon desde otra pantalla antes del "sí", no devuelve el dinero dos veces',
      async () => {
        const id = await insertExpense({ description: 'Pago de luz', amount: 80000 });
        const trigger = 'elimina el gasto de luz';
        await tools.prepareVoid(cid, owner, { query: 'luz' }, ctx(trigger));
        await voidAction.execute(Number(id), cid, { id: ownerId, fullName: 'E2E Owner' });
        const afterManualVoid = await balance('cash_registers', registerId);

        const result = await tools.confirm(cid, owner, ctx('sí', trigger));
        expect(result.status).toBe('already_archived');
        expect(await balance('cash_registers', registerId)).toBe(afterManualVoid);
      },
    );

    itDb('si el gasto cambió (concepto editado) tras el resumen, no se archiva', async () => {
      const id = await insertExpense({ description: 'Pago de luz', amount: 80000 });
      const trigger = 'elimina el gasto de luz';
      await tools.prepareVoid(cid, owner, { query: 'luz' }, ctx(trigger));
      await q(`UPDATE expenses SET description = 'Pago de luz local 2' WHERE id = $1`, [id]);

      const result = await tools.confirm(cid, owner, ctx('sí', trigger));
      expect(result.status).toBe('failed');
      const [row] = await q<{ is_archived: boolean }>(
        `SELECT is_archived FROM expenses WHERE id = $1`,
        [id],
      );
      expect(row.is_archived).toBe(false);
      expect(await balance('cash_registers', registerId)).toBe(CASH_START);
    });
  });

  describe('VoidExpenseAction · lock de la fila', () => {
    itDb('dos anulaciones simultáneas del mismo gasto devuelven el dinero UNA vez', async () => {
      const id = await insertExpense({ description: 'Gas', amount: 40000 });
      const actor = { id: ownerId, fullName: 'E2E Owner' };

      // A anula y deja su transacción ABIERTA mientras B arranca: carrera real.
      // Sin el FOR UPDATE del gasto, B lo leería activo y devolvería el dinero
      // otra vez cuando A haga commit.
      let releaseA!: () => void;
      let aDone!: () => void;
      const gate = new Promise<void>((resolve) => (releaseA = resolve));
      const aReady = new Promise<void>((resolve) => (aDone = resolve));
      const first = db().transaction(async (manager) => {
        await voidAction.runInTransaction(manager, Number(id), cid, actor);
        aDone();
        await gate;
      });
      await aReady;
      const second = voidAction.execute(Number(id), cid, actor);
      await sleep(250);
      releaseA();
      const results = await Promise.allSettled([first, second]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(await balance('cash_registers', registerId)).toBe(CASH_START + 40000);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Quién puede escribir
  // ────────────────────────────────────────────────────────────────────────

  describe('ResolveAiActorAction · is_administrator', () => {
    const roleId = async (name: string): Promise<string> =>
      (
        await q<{ id: string }>(`SELECT id FROM roles WHERE company_id = $1 AND name = $2`, [
          String(cid),
          name,
        ])
      )[0].id;

    const employeeUser = async (role: string | null, archived = false): Promise<number> => {
      const [user] = await q<{ id: string }>(
        `INSERT INTO users (name, lastname, email, password, type, company_id)
         VALUES ('Emp', 'Leado', $1, 'x', 'employee', $2) RETURNING id`,
        [`__e2e_ai_emp_${randomUUID()}@example.test`, String(cid)],
      );
      await q(
        `INSERT INTO employees (company_id, name, role, user_id, role_id, is_archived)
         VALUES ($1, 'Emp', 'employee', $2, $3, $4)`,
        [String(cid), user.id, role ? await roleId(role) : null, archived],
      );
      return Number(user.id);
    };

    const resolve = async (user_id: number, type: 'owner' | 'employee'): Promise<boolean> => {
      const resolver = new ResolveAiActorAction(db(), {
        execute: jest.fn().mockResolvedValue([]),
      } as unknown as ResolveEffectivePermissionsAction);
      const auth = {
        user_id,
        company_id: cid,
        name: 'X',
        lastname: 'Y',
        type,
        account: type === 'owner' ? 'user' : 'employee',
      } as AuthUser;
      return (await resolver.execute(auth, cid)).is_administrator;
    };

    itDb('owner → sí', async () => {
      expect(await resolve(ownerId, 'owner')).toBe(true);
    });
    itDb('empleado con rol Administrador → sí', async () => {
      expect(await resolve(await employeeUser('Administrador'), 'employee')).toBe(true);
    });
    itDb('empleado Cajero / Vendedor / sin rol → no', async () => {
      expect(await resolve(await employeeUser('Cajero'), 'employee')).toBe(false);
      expect(await resolve(await employeeUser('Vendedor'), 'employee')).toBe(false);
      expect(await resolve(await employeeUser(null), 'employee')).toBe(false);
    });
    itDb('empleado Administrador ARCHIVADO → no', async () => {
      expect(await resolve(await employeeUser('Administrador', true), 'employee')).toBe(false);
    });
    itDb('rol Administrador de OTRA company no cuenta', async () => {
      await seedSystemRolesForCompany(db().manager, otherCid);
      const [foreignRole] = await q<{ id: string }>(
        `SELECT id FROM roles WHERE company_id = $1 AND name = 'Administrador'`,
        [String(otherCid)],
      );
      const user_id = await employeeUser(null);
      await q(`UPDATE employees SET role_id = $1 WHERE user_id = $2`, [
        foreignRole.id,
        String(user_id),
      ]);
      expect(await resolve(user_id, 'employee')).toBe(false);
    });
  });
});
