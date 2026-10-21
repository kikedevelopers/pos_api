import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { TransferAction } from '@/modules/accounts/actions/transfer.action';
import { RunAiTreasuryToolAction } from '@/modules/ai/actions/run-ai-treasury-tool.action';
import type { AiToolRequestContext } from '@/modules/ai/internal/expense-tool-helpers';
import type { AiToolActor } from '@/modules/ai/internal/tool-catalog';
import { ApplyBankAdjustmentAction } from '@/modules/banks/actions/apply-bank-adjustment.action';
import { AdjustCashRegisterAction } from '@/modules/cash-register/actions/adjust-cash-register.action';
import type { GetCashRegisterBalanceAction } from '@/modules/cash-register/actions/get-balance.action';
import type { ListCashRegisterLogsAction } from '@/modules/cash-register/actions/list-cash-register-logs.action';
import { RecordCashRegisterLogAction } from '@/modules/cash-register/actions/record-cash-register-log.action';
import { CashRegisterService } from '@/modules/cash-register/cash-register.service';
import { ListFinancialMovementsAction } from '@/modules/financial-movements/actions/list-financial-movements.action';
import { RecordFinancialMovementAction } from '@/modules/financial-movements/actions/record-financial-movement.action';
import { FinancialMovement } from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { TransferCashAction } from '@/modules/pos-data/actions/transfer-cash.action';
import { ApplyWalletAdjustmentAction } from '@/modules/wallets/actions/apply-wallet-adjustment.action';

import {
  cleanupCompany,
  createDisposableCompany,
  insertOwnerUser,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL pos_db) — Place mueve y corrige saldos de tesorería.
 *
 * Lo que se fija aquí (lo que NO puede fallar, es dinero real):
 *   - Nada se mueve sin un "sí" explícito en un turno POSTERIOR que responda a
 *     ESE resumen; preparar no toca un peso.
 *   - Sin saldo suficiente se rechaza al preparar y otra vez al confirmar.
 *   - Lo ejecutado es EXACTAMENTE lo preparado, con los mismos efectos que
 *     "Mover saldo" / "Corregir caja": saldos, movimientos financieros y logs.
 *   - Exactamente una vez: confirmaciones repetidas o simultáneas no duplican.
 *   - Una corrección no se aplica si el saldo cambió desde el resumen.
 *   - Aislamiento: cuentas y pendientes de otra company son invisibles.
 *   - Solo el dueño (ni el rol Administrador).
 */

const COMPANY = '__E2E_AI_TREASURY_TOOLS__';
const OTHER_COMPANY = '__E2E_AI_TREASURY_TOOLS_OTHER__';
const NEQUI_START = 100000;
const BANCOLOMBIA_START = 500000;
const EFECTIVO_START = 300000;
const OWN_CASH_START = 80000;
const ANA_CASH_START = 60000;

const canConnectPromise = tryInitDataSource();

describe('Place · herramientas de tesorería (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let cid = 0;
  let otherCid = 0;
  let ownerId = 0;
  let otherOwnerId = 0;
  let anaId = 0;
  let ownRegisterId = '';
  let anaRegisterId = '';
  let nequiId = '';
  let bancolombiaId = '';
  let efectivoId = '';
  let archivedWalletId = '';
  let tools: RunAiTreasuryToolAction;
  let owner: AiToolActor;
  let otherOwner: AiToolActor;

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

  const balances = async (): Promise<Record<string, number>> => ({
    nequi: await balance('banks', nequiId),
    bancolombia: await balance('banks', bancolombiaId),
    efectivo: await balance('wallets', efectivoId),
    own_cash: await balance('cash_registers', ownRegisterId),
    ana_cash: await balance('cash_registers', anaRegisterId),
  });

  const INITIAL = (): Record<string, number> => ({
    nequi: NEQUI_START,
    bancolombia: BANCOLOMBIA_START,
    efectivo: EFECTIVO_START,
    own_cash: OWN_CASH_START,
    ana_cash: ANA_CASH_START,
  });

  const pendingRows = (
    company_id = cid,
  ): Promise<Array<{ status: string; action_type: string; result_ref: string | null }>> =>
    q(
      `SELECT status, action_type, result_ref FROM ai_pending_actions
        WHERE company_id = $1 ORDER BY id`,
      [String(company_id)],
    );

  const movements = (): Promise<
    Array<{
      movement_type: string;
      concept: string;
      amount: string;
      description: string;
      source_type: string | null;
      destination_type: string | null;
      reference_code: string;
      created_by_id: string;
    }>
  > =>
    q(
      `SELECT movement_type, concept, amount, description, source_type, destination_type,
              reference_code, created_by_id::text AS created_by_id
         FROM financial_movements WHERE company_id = $1 ORDER BY id`,
      [String(cid)],
    );

  const cashLogs = (): Promise<
    Array<{ cash_register_id: string; type: string; direction: string; amount: string }>
  > =>
    q(
      `SELECT cash_register_id::text AS cash_register_id, type, direction, amount
         FROM cash_register_logs WHERE company_id = $1 ORDER BY id`,
      [String(cid)],
    );

  const transfer = (
    args: Record<string, unknown>,
    trigger: string,
    actor: AiToolActor = owner,
  ): Promise<Record<string, unknown>> => tools.prepareTransfer(cid, actor, args, ctx(trigger));

  const correction = (
    args: Record<string, unknown>,
    trigger: string,
    actor: AiToolActor = owner,
  ): Promise<Record<string, unknown>> => tools.prepareCorrection(cid, actor, args, ctx(trigger));

  const confirm = (trigger: string, reply = 'sí'): Promise<Record<string, unknown>> =>
    tools.confirm(cid, owner, ctx(reply, trigger));

  beforeAll(async () => {
    ds = await canConnectPromise;
    if (!ds) {
      return;
    }
    cid = await createDisposableCompany(ds, COMPANY);
    otherCid = await createDisposableCompany(ds, OTHER_COMPANY);
    ownerId = await insertOwnerUser(ds, cid, 'ai_treasury');
    otherOwnerId = await insertOwnerUser(ds, otherCid, 'ai_treasury_other');
    anaId = Number(
      (
        await q<{ id: string }>(
          `INSERT INTO users (name, lastname, email, password, type, company_id)
           VALUES ('Ana', 'Gómez', $1, 'x', 'employee', $2) RETURNING id`,
          [`__e2e_ai_treasury_ana_${Date.now()}@example.test`, String(cid)],
        )
      )[0].id,
    );

    const insertId = async (sql: string, params: unknown[]): Promise<string> =>
      (await q<{ id: string }>(sql, params))[0].id;
    ownRegisterId = await insertId(
      `INSERT INTO cash_registers (company_id, user_id, balance) VALUES ($1, $2, 0) RETURNING id`,
      [String(cid), String(ownerId)],
    );
    anaRegisterId = await insertId(
      `INSERT INTO cash_registers (company_id, user_id, balance) VALUES ($1, $2, 0) RETURNING id`,
      [String(cid), String(anaId)],
    );
    nequiId = await insertId(
      `INSERT INTO banks (company_id, name, account_number, balance) VALUES ($1, 'NEQUI', '3117', 0) RETURNING id`,
      [String(cid)],
    );
    bancolombiaId = await insertId(
      `INSERT INTO banks (company_id, name, account_number, balance) VALUES ($1, 'BANCOLOMBIA', '718', 0) RETURNING id`,
      [String(cid)],
    );
    efectivoId = await insertId(
      `INSERT INTO wallets (company_id, name, balance) VALUES ($1, 'Efectivo', 0) RETURNING id`,
      [String(cid)],
    );
    archivedWalletId = await insertId(
      `INSERT INTO wallets (company_id, name, balance, is_archived) VALUES ($1, 'Vieja', 5000, true) RETURNING id`,
      [String(cid)],
    );
    // Otra company con cuentas homónimas: jamás deben aparecer ni moverse.
    await q(
      `INSERT INTO wallets (company_id, name, balance) VALUES ($1, 'Efectivo', 999999), ($1, 'Davivienda', 1)`,
      [String(otherCid)],
    );

    const financial = new FinancialMovementsService(
      new ListFinancialMovementsAction(ds.getRepository(FinancialMovement)),
      new RecordFinancialMovementAction(),
    );
    const cashAdjustment = new AdjustCashRegisterAction(ds, financial);
    const cashService = new CashRegisterService(
      {} as unknown as GetCashRegisterBalanceAction,
      {} as unknown as ListCashRegisterLogsAction,
      new RecordCashRegisterLogAction(),
      cashAdjustment,
    );
    tools = new RunAiTreasuryToolAction(
      ds,
      new TransferAction(ds, financial, cashService),
      new TransferCashAction(ds, financial),
      new ApplyBankAdjustmentAction(ds, financial),
      new ApplyWalletAdjustmentAction(ds, financial),
      cashAdjustment,
    );

    owner = {
      isAdmin: true,
      permissions: new Set<string>(),
      canViewProfit: true,
      userId: ownerId,
      is_administrator: true,
      full_name: 'E2E Owner',
    };
    otherOwner = { ...owner, userId: otherOwnerId };
  });

  afterAll(async () => {
    if (ds) {
      for (const company of [cid, otherCid]) {
        for (const table of [
          'ai_pending_actions',
          'financial_movements',
          'cash_register_logs',
          'cash_registers',
          'banks',
          'wallets',
        ]) {
          await q(`DELETE FROM ${table} WHERE company_id = $1`, [String(company)]);
        }
        await cleanupCompany(ds, company);
      }
      await ds.destroy();
    }
  });

  beforeEach(async () => {
    if (!ds) {
      return;
    }
    for (const table of ['ai_pending_actions', 'financial_movements', 'cash_register_logs']) {
      await q(`DELETE FROM ${table} WHERE company_id = $1`, [String(cid)]);
    }
    await q(`DELETE FROM wallets WHERE company_id = $1 AND name = 'Nequi'`, [String(cid)]);
    await q(`UPDATE banks SET balance = $2 WHERE id = $1`, [nequiId, NEQUI_START]);
    await q(`UPDATE banks SET balance = $2 WHERE id = $1`, [bancolombiaId, BANCOLOMBIA_START]);
    await q(`UPDATE wallets SET balance = $2 WHERE id = $1`, [efectivoId, EFECTIVO_START]);
    await q(`UPDATE cash_registers SET balance = $2 WHERE id = $1`, [
      ownRegisterId,
      OWN_CASH_START,
    ]);
    await q(`UPDATE cash_registers SET balance = $2 WHERE id = $1`, [
      anaRegisterId,
      ANA_CASH_START,
    ]);
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
  // Preparar un traslado — nunca adivina, nunca mueve
  // ────────────────────────────────────────────────────────────────────────

  describe('prepare_treasury_transfer · validación', () => {
    itDb('sin datos pide los 3 y lista SOLO las cuentas activas de esta company', async () => {
      const result = await transfer({}, 'mueve plata');

      expect(result.status).toBe('missing_data');
      expect(result.missing).toEqual(['cuenta de origen', 'cuenta de destino', 'valor']);
      const names = (result.accounts as Array<{ name: string }>).map((a) => a.name).sort();
      expect(names).toEqual(
        ['BANCOLOMBIA - 718', 'Caja de Ana Gómez', 'Efectivo', 'Mi caja', 'NEQUI - 3117'].sort(),
      );
      expect(await pendingRows()).toEqual([]);
    });

    itDb('"100.000" como texto se rechaza (no se mueven 100 pesos)', async () => {
      const result = await transfer(
        { from: 'Nequi', to: 'Efectivo', amount: '100.000' },
        'mueve 100.000 de nequi a efectivo',
      );
      expect(result.status).toBe('invalid_data');
      expect(await pendingRows()).toEqual([]);
    });

    itDb('valor cero o negativo se rechaza', async () => {
      for (const amount of [0, -5000]) {
        const result = await transfer({ from: 'Nequi', to: 'Efectivo', amount }, 'mueve');
        expect(result.status).toBe('invalid_data');
      }
      expect(await pendingRows()).toEqual([]);
    });

    itDb('una cuenta de OTRA company o archivada no existe aquí', async () => {
      const davivienda = await transfer(
        { from: 'Davivienda', to: 'Efectivo', amount: 1 },
        'mueve 1 de davivienda a efectivo',
      );
      expect(davivienda).toMatchObject({ status: 'account_not_found', field: 'from' });
      const archived = await transfer(
        { from: 'Nequi', to: 'Vieja', amount: 1 },
        'mueve 1 de nequi a vieja',
      );
      expect(archived).toMatchObject({ status: 'account_not_found', field: 'to' });
      expect(await pendingRows()).toEqual([]);
      expect(await balance('wallets', archivedWalletId)).toBe(5000);
    });

    itDb('dos cuentas con el mismo nombre → pregunta cuál (con el tipo se resuelve)', async () => {
      await q(`INSERT INTO wallets (company_id, name, balance) VALUES ($1, 'Nequi', 0)`, [
        String(cid),
      ]);
      const ambiguous = await transfer(
        { from: 'Nequi', to: 'Efectivo', amount: 1000 },
        'mueve mil de nequi a efectivo',
      );
      expect(ambiguous).toMatchObject({ status: 'ambiguous_account', field: 'from' });
      expect(await pendingRows()).toEqual([]);

      const resolved = await transfer(
        { from: 'banco Nequi', to: 'Efectivo', amount: 1000 },
        'mueve mil del banco nequi a efectivo',
      );
      expect(resolved.status).toBe('confirmation_required');
    });

    itDb('SALDO INSUFICIENTE: se rechaza sin preparar nada', async () => {
      const result = await transfer(
        { from: 'Nequi', to: 'Efectivo', amount: NEQUI_START + 1 },
        'mueve 100001 de nequi a efectivo',
      );
      expect(result).toMatchObject({
        status: 'insufficient_balance',
        account: 'NEQUI - 3117',
        available: NEQUI_START,
        requested: NEQUI_START + 1,
      });
      expect(await pendingRows()).toEqual([]);
      expect(await balances()).toEqual(INITIAL());
    });

    itDb('rutas que la app no permite se rechazan con la alternativa', async () => {
      for (const [from, to] of [
        ['Nequi', 'caja de Ana'],
        ['Efectivo', 'mi caja'],
        ['mi caja', 'caja de Ana'],
        ['Nequi', 'banco Nequi'],
      ]) {
        const result = await transfer({ from, to, amount: 1000 }, `mueve mil de ${from} a ${to}`);
        expect(result.status).toBe('unsupported');
      }
      expect(await pendingRows()).toEqual([]);
    });

    itDb('un empleado con rol Administrador NO puede (solo el dueño)', async () => {
      const administrator: AiToolActor = {
        ...owner,
        isAdmin: false,
        is_administrator: true,
        userId: anaId,
      };
      const result = await transfer(
        { from: 'Nequi', to: 'Efectivo', amount: 1000 },
        'mueve mil de nequi a efectivo',
        administrator,
      );
      expect(result.status).toBe('forbidden');
      expect(await tools.confirm(cid, administrator, ctx('sí', 'x'))).toMatchObject({
        status: 'forbidden',
      });
      expect(await pendingRows()).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Traslado + confirmación — ejecuta EXACTAMENTE lo preparado
  // ────────────────────────────────────────────────────────────────────────

  describe('prepare_treasury_transfer + confirm · todas las rutas', () => {
    itDb('banco → billetera: resumen exacto, nada se mueve hasta el "sí"', async () => {
      const trigger = 'mueve 40 mil de Nequi a Efectivo';
      const prepared = await transfer({ from: 'Nequi', to: 'Efectivo', amount: 40000 }, trigger);

      expect(prepared).toMatchObject({
        status: 'confirmation_required',
        summary: {
          operation: 'transfer',
          amount: 40000,
          from: { name: 'NEQUI - 3117', kind: 'banco', balance: 100000, balance_after: 60000 },
          to: { name: 'Efectivo', kind: 'billetera', balance: 300000, balance_after: 340000 },
        },
      });
      expect(await balances()).toEqual(INITIAL());
      expect(await movements()).toEqual([]);

      const confirmed = await confirm(trigger);
      expect(confirmed).toMatchObject({
        status: 'executed',
        result: {
          operation: 'transfer',
          amount: 40000,
          from: { name: 'NEQUI - 3117', balance: 60000 },
          to: { name: 'Efectivo', balance: 340000 },
        },
      });
      expect(await balances()).toEqual({ ...INITIAL(), nequi: 60000, efectivo: 340000 });

      // Mismo par EXPENSE + INCOME que "Mover saldo", firmado por el dueño.
      const fm = await movements();
      expect(fm.map((m) => [m.movement_type, m.concept, Number(m.amount)])).toEqual([
        ['EXPENSE', 'TRANSFER', 40000],
        ['INCOME', 'TRANSFER', 40000],
      ]);
      expect(fm[0].reference_code).toBe(fm[1].reference_code);
      expect(fm.every((m) => m.created_by_id === String(ownerId))).toBe(true);
      expect(await pendingRows()).toEqual([
        {
          status: 'EXECUTED',
          action_type: 'TRANSFER_FUNDS',
          result_ref: null,
        },
      ]);
    });

    itDb(
      'billetera → caja de otro usuario: la caja de Ana sube y queda el log de entrada',
      async () => {
        const trigger = 'pasa 25 mil de efectivo a la caja de Ana';
        await transfer({ from: 'Efectivo', to: 'caja de Ana', amount: 25000 }, trigger);
        expect((await confirm(trigger)).status).toBe('executed');

        expect(await balances()).toEqual({ ...INITIAL(), efectivo: 275000, ana_cash: 85000 });
        expect(await cashLogs()).toEqual([
          {
            cash_register_id: anaRegisterId,
            type: 'CASH_TRANSFER_IN',
            direction: 'IN',
            amount: '25000.00',
          },
        ]);
      },
    );

    itDb('caja de otro usuario → banco: sale de la caja de Ana (no de la del dueño)', async () => {
      const trigger = 'mueve 60 mil de la caja de Ana a Bancolombia';
      await transfer({ from: 'caja de Ana', to: 'Bancolombia', amount: 60000 }, trigger);
      expect((await confirm(trigger)).status).toBe('executed');

      expect(await balances()).toEqual({ ...INITIAL(), ana_cash: 0, bancolombia: 560000 });
      expect(await cashLogs()).toEqual([
        {
          cash_register_id: anaRegisterId,
          type: 'CASH_TRANSFER_OUT',
          direction: 'OUT',
          amount: '60000.00',
        },
      ]);
    });

    itDb('caja propia → billetera', async () => {
      const trigger = 'mueve 30 mil de mi caja a efectivo';
      await transfer({ from: 'mi caja', to: 'billetera Efectivo', amount: 30000 }, trigger);
      expect((await confirm(trigger)).status).toBe('executed');
      expect(await balances()).toEqual({ ...INITIAL(), own_cash: 50000, efectivo: 330000 });
    });

    itDb('billetera → banco y banco → banco', async () => {
      const first = 'mueve 1000 de efectivo a nequi';
      await transfer({ from: 'Efectivo', to: 'Nequi', amount: 1000 }, first);
      expect((await confirm(first)).status).toBe('executed');
      const second = 'mueve 1000.50 de bancolombia a nequi';
      await transfer({ from: 'Bancolombia', to: 'Nequi', amount: 1000.5 }, second);
      expect((await confirm(second)).status).toBe('executed');

      expect(await balances()).toEqual({
        ...INITIAL(),
        efectivo: 299000,
        bancolombia: 498999.5,
        nequi: 102000.5,
      });
    });

    itDb('todo el saldo exacto se puede mover (saldo queda en 0)', async () => {
      const trigger = 'mueve todo nequi a efectivo';
      await transfer({ from: 'Nequi', to: 'Efectivo', amount: NEQUI_START }, trigger);
      expect((await confirm(trigger)).status).toBe('executed');
      expect((await balances()).nequi).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Confirmación — exactamente una vez, solo con el "sí"
  // ────────────────────────────────────────────────────────────────────────

  describe('confirm_treasury_action · el "sí" y nada más', () => {
    itDb('preparar y confirmar en la MISMA petición no mueve nada', async () => {
      const request_id = randomUUID();
      const trigger = 'mueve 10 mil de nequi a efectivo';
      await tools.prepareTransfer(
        cid,
        owner,
        { from: 'Nequi', to: 'Efectivo', amount: 10000 },
        ctx(trigger, null, request_id),
      );
      const result = await tools.confirm(cid, owner, ctx(trigger, null, request_id));
      expect(result.status).toBe('awaiting_user_reply');
      expect(await balances()).toEqual(INITIAL());
    });

    itDb('"sí, pero de 50 mil" no confirma: vence la pendiente sin mover nada', async () => {
      const trigger = 'mueve 10 mil de nequi a efectivo';
      await transfer({ from: 'Nequi', to: 'Efectivo', amount: 10000 }, trigger);
      const result = await confirm(trigger, 'sí, pero de 50 mil');
      expect(result.status).toBe('confirmation_not_explicit');
      expect(await balances()).toEqual(INITIAL());
      expect((await pendingRows())[0].status).toBe('EXPIRED');
      // Un "sí" después ya no revive la vencida.
      expect((await confirm(trigger)).status).toBe('no_pending_action');
    });

    itDb('el "sí" a OTRO mensaje no confirma (stale)', async () => {
      await transfer({ from: 'Nequi', to: 'Efectivo', amount: 10000 }, 'mueve 10 mil');
      const result = await tools.confirm(cid, owner, ctx('sí', 'otra cosa'));
      expect(result.status).toBe('stale_confirmation');
      expect(await balances()).toEqual(INITIAL());
    });

    itDb('un segundo "sí" no repite el traslado', async () => {
      const trigger = 'mueve 10 mil de nequi a efectivo';
      await transfer({ from: 'Nequi', to: 'Efectivo', amount: 10000 }, trigger);
      expect((await confirm(trigger)).status).toBe('executed');
      expect((await confirm(trigger)).status).toBe('no_pending_action');
      expect(await balances()).toEqual({ ...INITIAL(), nequi: 90000, efectivo: 310000 });
      expect(await movements()).toHaveLength(2);
    });

    itDb('dos "sí" SIMULTÁNEOS: se ejecuta exactamente una vez', async () => {
      const trigger = 'mueve 10 mil de nequi a efectivo';
      await transfer({ from: 'Nequi', to: 'Efectivo', amount: 10000 }, trigger);
      const results = await Promise.all([confirm(trigger), confirm(trigger), confirm(trigger)]);

      expect(results.filter((r) => r.status === 'executed')).toHaveLength(1);
      expect(await balances()).toEqual({ ...INITIAL(), nequi: 90000, efectivo: 310000 });
      expect(await movements()).toHaveLength(2);
    });

    itDb('si el saldo bajó después del resumen, el "sí" falla con rollback total', async () => {
      const trigger = 'mueve 90 mil de nequi a efectivo';
      await transfer({ from: 'Nequi', to: 'Efectivo', amount: 90000 }, trigger);
      await q(`UPDATE banks SET balance = 50000 WHERE id = $1`, [nequiId]);

      const result = await confirm(trigger);
      expect(result.status).toBe('failed');
      expect(String(result.message)).toMatch(/Saldo insuficiente/);
      expect(await balances()).toEqual({ ...INITIAL(), nequi: 50000 });
      expect(await movements()).toEqual([]);
      expect((await pendingRows())[0].status).toBe('PENDING');
    });

    itDb('la pendiente de otro tipo (un pedido) no se ejecuta con esta herramienta', async () => {
      const trigger = 'véndele a Juan';
      await q(
        `INSERT INTO ai_pending_actions
           (company_id, user_id, action_type, payload, request_id, trigger_message_hash, expires_at)
         VALUES ($1, $2, 'CREATE_SALE', '{}'::jsonb, $3::uuid, 'x', now() + interval '5 minutes')`,
        [String(cid), String(ownerId), randomUUID()],
      );
      const result = await confirm(trigger);
      expect(result.status).toBe('wrong_operation');
      expect(String(result.message)).toContain('confirm_sale');
      expect((await pendingRows())[0].status).toBe('PENDING');
    });

    itDb('el dueño de OTRA company no confirma la pendiente de esta', async () => {
      const trigger = 'mueve 10 mil de nequi a efectivo';
      await transfer({ from: 'Nequi', to: 'Efectivo', amount: 10000 }, trigger);
      const result = await tools.confirm(otherCid, otherOwner, ctx('sí', trigger));
      expect(result.status).toBe('no_pending_action');
      expect(await balances()).toEqual(INITIAL());
      expect((await pendingRows())[0].status).toBe('PENDING');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Corregir saldo — queda EXACTAMENTE en el valor pedido
  // ────────────────────────────────────────────────────────────────────────

  describe('prepare_balance_correction + confirm', () => {
    itDb('"Corrige Nequi a 10.000": baja al valor exacto con un egreso de ajuste', async () => {
      const trigger = 'Corrige el saldo de Nequi a 10.000';
      const prepared = await correction({ account: 'Nequi', target_balance: 10000 }, trigger);
      expect(prepared).toMatchObject({
        status: 'confirmation_required',
        summary: {
          operation: 'adjust',
          account: { name: 'NEQUI - 3117', kind: 'banco' },
          balance: 100000,
          target_balance: 10000,
          difference: -90000,
          reason: 'Corrección con Place',
        },
      });
      expect(await balances()).toEqual(INITIAL());

      expect(await confirm(trigger)).toMatchObject({
        status: 'executed',
        result: { operation: 'adjust', balance: 10000, difference: -90000 },
      });
      expect((await balances()).nequi).toBe(10000);
      const [fm] = await movements();
      expect(fm).toMatchObject({
        movement_type: 'EXPENSE',
        concept: 'ADJUSTMENT',
        amount: '90000.00',
        source_type: 'bank',
        description: 'Corrección de caja: Corrección con Place',
      });
    });

    itDb('sube una billetera con un ingreso de ajuste y guarda el motivo', async () => {
      const trigger = 'ajusta efectivo a 350 mil, arqueo';
      await correction({ account: 'Efectivo', target_balance: 350000, reason: 'arqueo' }, trigger);
      expect((await confirm(trigger)).status).toBe('executed');
      expect((await balances()).efectivo).toBe(350000);
      const [fm] = await movements();
      expect(fm).toMatchObject({
        movement_type: 'INCOME',
        concept: 'ADJUSTMENT',
        amount: '50000.00',
        destination_type: 'wallet',
        description: 'Corrección de caja: arqueo (con Place)',
      });
    });

    itDb('se puede dejar en 0', async () => {
      const trigger = 'deja bancolombia en 0';
      await correction({ account: 'Bancolombia', target_balance: 0 }, trigger);
      expect((await confirm(trigger)).status).toBe('executed');
      expect((await balances()).bancolombia).toBe(0);
    });

    itDb('corrige la caja propia y la de un empleado con su log de ajuste', async () => {
      const own = 'corrige mi caja a 100 mil';
      await correction({ account: 'mi caja', target_balance: 100000 }, own);
      expect((await confirm(own)).status).toBe('executed');
      const ana = 'corrige la caja de Ana a 0';
      await correction({ account: 'caja de Ana', target_balance: 0 }, ana);
      expect((await confirm(ana)).status).toBe('executed');

      expect(await balances()).toEqual({ ...INITIAL(), own_cash: 100000, ana_cash: 0 });
      expect(await cashLogs()).toEqual([
        {
          cash_register_id: ownRegisterId,
          type: 'ADMIN_ADJUSTMENT',
          direction: 'IN',
          amount: '20000.00',
        },
        {
          cash_register_id: anaRegisterId,
          type: 'ADMIN_ADJUSTMENT',
          direction: 'OUT',
          amount: '60000.00',
        },
      ]);
    });

    itDb('si ya tiene ese saldo no prepara nada', async () => {
      const result = await correction({ account: 'Nequi', target_balance: NEQUI_START }, 'corrige');
      expect(result.status).toBe('no_change');
      expect(await pendingRows()).toEqual([]);
    });

    itDb('negativo, separadores de miles o motivo enorme se rechazan', async () => {
      for (const args of [
        { account: 'Nequi', target_balance: -1 },
        { account: 'Nequi', target_balance: '10.000' },
        { account: 'Nequi', target_balance: 10000, reason: 'x'.repeat(201) },
      ]) {
        expect((await correction(args, 'corrige nequi')).status).toBe('invalid_data');
      }
      expect((await correction({ account: 'Nequi' }, 'corrige nequi')).status).toBe('missing_data');
      expect(await pendingRows()).toEqual([]);
    });

    itDb(
      'si el saldo CAMBIÓ desde el resumen no corrige (la diferencia ya no es la confirmada)',
      async () => {
        const trigger = 'corrige nequi a 10 mil';
        await correction({ account: 'Nequi', target_balance: 10000 }, trigger);
        await q(`UPDATE banks SET balance = 120000 WHERE id = $1`, [nequiId]);

        const result = await confirm(trigger);
        expect(result.status).toBe('changed');
        expect((await balances()).nequi).toBe(120000);
        expect(await movements()).toEqual([]);
        expect((await pendingRows())[0].status).toBe('EXPIRED');
      },
    );

    itDb(
      'una nueva preparación reemplaza a la anterior: el "sí" ejecuta solo la última',
      async () => {
        await correction({ account: 'Nequi', target_balance: 10000 }, 'corrige nequi a 10 mil');
        const trigger = 'mejor a 20 mil';
        await correction({ account: 'Nequi', target_balance: 20000 }, trigger);
        expect((await confirm(trigger)).status).toBe('executed');
        expect((await balances()).nequi).toBe(20000);
        expect((await pendingRows()).map((p) => p.status)).toEqual(['SUPERSEDED', 'EXECUTED']);
      },
    );
  });
});
