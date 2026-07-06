import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { Expense } from '@/modules/expenses/entities/expense.entity';

import { PayFixedExpensePeriodsAction } from '../actions/pay-fixed-expense-periods.action';
import { FixedExpensePeriod } from '../entities/fixed-expense-period.entity';
import { FixedExpense } from '../entities/fixed-expense.entity';

/**
 * Tests del pago multi-corte / parcial (§4 del contrato
 * `CONTRACT_fixed_expense_periods_pay.md`):
 *   - asignación oldest-first (paga completos los viejos),
 *   - pago parcial del último corte que alcance,
 *   - rechazo de sobre-pago (amount > Σ saldo) → 400,
 *   - saldo insuficiente en la fuente → 422,
 *   - corte ajeno al gasto → 404.
 *
 * Se mockea el EntityManager para simular un banco con balance y un conjunto de
 * cortes en memoria; las mutaciones (`update`) se aplican al estado para poder
 * verificar el resultado final de cada corte.
 */

const ACTOR = { id: 1, fullName: 'Kike Pacheco' };
const COMPANY_ID = 7;
const FIXED_EXPENSE_ID = 10;

interface PeriodState {
  id: string;
  fixed_expense_id: string;
  company_id: string;
  period_number: number;
  amount: number;
  paid_amount: number;
  balance: number;
  status: string;
  due_at: Date;
  alert_id: string | null;
  paid_at: Date | null;
  paid_by_id: string | null;
  expense_id: string | null;
  created_at: Date;
  updated_at: Date;
}

// Fecha base fija para los campos temporales serializados por el DTO
// (`due_at`/`created_at`/`updated_at`). No hay Date.now en scripts de prueba;
// un instante constante basta (las aserciones son sobre saldos, no fechas).
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

function makePeriod(
  over: Partial<PeriodState> & { id: string; period_number: number; amount: number },
): PeriodState {
  return {
    fixed_expense_id: String(FIXED_EXPENSE_ID),
    company_id: String(COMPANY_ID),
    paid_amount: 0,
    balance: over.amount,
    status: 'PENDING',
    due_at: FIXED_DATE,
    alert_id: null,
    paid_at: null,
    paid_by_id: null,
    expense_id: null,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    ...over,
  };
}

/** Busca un corte por id; lanza si no existe (evita non-null assertion). */
function byId(periods: PeriodState[], id: string): PeriodState {
  const found = periods.find((p) => p.id === id);
  if (!found) {
    throw new Error(`Corte ${id} no encontrado en el estado de prueba.`);
  }
  return found;
}

interface BankState {
  id: string;
  company_id: string;
  name: string;
  account_number: string;
  balance: number;
  is_archived: boolean;
}

/**
 * Construye un manager mock con estado en memoria de cortes + banco.
 */
function buildManager(opts: { periods: PeriodState[]; bank: BankState | null }) {
  const periods = opts.periods;
  const bank = opts.bank;
  let expenseSeq = 0;

  const manager = {
    findOne: jest.fn((entity: unknown, options: { where: Record<string, unknown> }) => {
      if (entity === FixedExpense) {
        const where = options.where;
        if (where.id === String(FIXED_EXPENSE_ID) && where.company_id === String(COMPANY_ID)) {
          return Promise.resolve({ id: String(FIXED_EXPENSE_ID), name: 'Arriendo' });
        }
        return Promise.resolve(null);
      }
      if (entity === Bank) {
        if (bank && (options.where.id as string) === bank.id && !bank.is_archived) {
          return Promise.resolve(bank);
        }
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    }),
    find: jest.fn((entity: unknown, options: { where: Record<string, unknown> }) => {
      if (entity !== FixedExpensePeriod) {
        return Promise.resolve([]);
      }
      const where = options.where;
      // El where.id puede ser un FindOperator In(...) — lo detectamos por _value.
      const idFilter = where.id as { _value?: string[] } | undefined;
      let rows = periods.filter(
        (p) =>
          p.fixed_expense_id === String(FIXED_EXPENSE_ID) && p.company_id === String(COMPANY_ID),
      );
      if (idFilter && Array.isArray(idFilter._value)) {
        const ids = new Set(idFilter._value);
        rows = rows.filter((p) => ids.has(p.id));
      }
      rows = [...rows].sort((a, b) => a.period_number - b.period_number);
      return Promise.resolve(rows);
    }),
    create: jest.fn((_entity: unknown, data: unknown) => data),
    save: jest.fn((entity: unknown, data: { id?: string }) => {
      if (entity === Expense) {
        expenseSeq += 1;
        return Promise.resolve({ ...data, id: String(100 + expenseSeq) });
      }
      return Promise.resolve(data);
    }),
    update: jest.fn(
      (
        entity: unknown,
        criteria: { id: string },
        patch: Partial<PeriodState> & { balance?: number },
      ) => {
        if (entity === Bank && bank) {
          if (typeof patch.balance === 'number') {
            bank.balance = patch.balance;
          }
          return Promise.resolve(undefined);
        }
        if (entity === FixedExpensePeriod) {
          const target = periods.find((p) => p.id === criteria.id);
          if (target) {
            Object.assign(target, patch);
          }
        }
        return Promise.resolve(undefined);
      },
    ),
    // La acción lee el snapshot de abonos con `manager.getRepository(Expense)`
    // (loadPeriodPayments). El mock no persiste Expenses consultables, así que
    // el repo devuelve [] → histórico embebido vacío (no afecta las aserciones
    // de saldos/paid_total). Añadido cuando el snapshot pasó a leerse en la TX.
    getRepository: jest.fn((entity: unknown) => ({
      find: (options: { where: Record<string, unknown> }) =>
        (manager.find as jest.Mock)(entity, options),
    })),
  };

  return { manager, periods, bank };
}

function buildAction(manager: unknown) {
  const dataSource = {
    transaction: jest.fn(async <T>(cb: (m: unknown) => Promise<T>) => cb(manager)),
  };
  const financialMovements = { record: jest.fn().mockResolvedValue({ id: '1' }) };
  const action = new PayFixedExpensePeriodsAction(dataSource as never, financialMovements as never);
  return { action, financialMovements };
}

const BANK = (balance: number): BankState => ({
  id: '5',
  company_id: String(COMPANY_ID),
  name: 'Bancolombia',
  account_number: '1234',
  balance,
  is_archived: false,
});

describe('PayFixedExpensePeriodsAction', () => {
  it('asigna oldest-first: paga completos los viejos y parcial el último que alcance', async () => {
    const periods = [
      makePeriod({ id: '11', period_number: 1, amount: 100 }),
      makePeriod({ id: '12', period_number: 2, amount: 100 }),
      makePeriod({ id: '13', period_number: 3, amount: 100 }),
    ];
    const { manager } = buildManager({ periods, bank: BANK(1000) });
    const { action, financialMovements } = buildAction(manager);

    // amount=250 sobre 3 cortes de 100 → corte1=100(PAID), corte2=100(PAID), corte3=50(PARTIAL).
    const result = await action.execute(
      FIXED_EXPENSE_ID,
      { source_type: 'bank', source_id: 5, amount: 250, period_ids: [11, 12, 13] },
      COMPANY_ID,
      ACTOR,
    );

    expect(result.paid_total).toBe(250);

    const p1 = byId(periods, '11');
    const p2 = byId(periods, '12');
    const p3 = byId(periods, '13');

    expect(p1.balance).toBe(0);
    expect(p1.paid_amount).toBe(100);
    expect(p1.status).toBe('PAID');
    expect(p1.paid_at).not.toBeNull();

    expect(p2.balance).toBe(0);
    expect(p2.status).toBe('PAID');

    expect(p3.balance).toBe(50);
    expect(p3.paid_amount).toBe(50);
    expect(p3.status).toBe('PARTIALLY_PAID');
    expect(p3.paid_at).toBeNull();

    // 3 cortes tocados (2 completos + 1 parcial) → 3 movimientos financieros.
    expect(financialMovements.record).toHaveBeenCalledTimes(3);
  });

  it('respeta el orden por period_number aunque period_ids venga desordenado', async () => {
    const periods = [
      makePeriod({ id: '11', period_number: 1, amount: 100 }),
      makePeriod({ id: '12', period_number: 2, amount: 100 }),
    ];
    const { manager } = buildManager({ periods, bank: BANK(1000) });
    const { action } = buildAction(manager);

    // period_ids al revés; amount=100 debe ir al corte 1 (más antiguo).
    await action.execute(
      FIXED_EXPENSE_ID,
      { source_type: 'bank', source_id: 5, amount: 100, period_ids: [12, 11] },
      COMPANY_ID,
      ACTOR,
    );

    expect(byId(periods, '11').status).toBe('PAID');
    expect(byId(periods, '12').status).toBe('PENDING');
    expect(byId(periods, '12').balance).toBe(100);
  });

  it('acumula sobre un corte ya parcialmente pagado', async () => {
    const periods = [
      makePeriod({
        id: '11',
        period_number: 1,
        amount: 100,
        paid_amount: 30,
        balance: 70,
        status: 'PARTIALLY_PAID',
      }),
    ];
    const { manager } = buildManager({ periods, bank: BANK(1000) });
    const { action } = buildAction(manager);

    await action.execute(
      FIXED_EXPENSE_ID,
      { source_type: 'bank', source_id: 5, amount: 70, period_ids: [11] },
      COMPANY_ID,
      ACTOR,
    );

    const p = byId(periods, '11');
    expect(p.paid_amount).toBe(100);
    expect(p.balance).toBe(0);
    expect(p.status).toBe('PAID');
  });

  it('rechaza sobre-pago (amount > Σ saldo seleccionado) con 400', async () => {
    const periods = [makePeriod({ id: '11', period_number: 1, amount: 100 })];
    const { manager } = buildManager({ periods, bank: BANK(1000) });
    const { action, financialMovements } = buildAction(manager);

    await expect(
      action.execute(
        FIXED_EXPENSE_ID,
        { source_type: 'bank', source_id: 5, amount: 150, period_ids: [11] },
        COMPANY_ID,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // No se debe haber tocado la fuente ni el corte.
    expect(financialMovements.record).not.toHaveBeenCalled();
    expect(periods[0].balance).toBe(100);
    expect(periods[0].status).toBe('PENDING');
  });

  it('rechaza saldo insuficiente en la fuente con 422', async () => {
    const periods = [makePeriod({ id: '11', period_number: 1, amount: 100 })];
    // Banco con saldo 40 < 100.
    const { manager } = buildManager({ periods, bank: BANK(40) });
    const { action } = buildAction(manager);

    await expect(
      action.execute(
        FIXED_EXPENSE_ID,
        { source_type: 'bank', source_id: 5, amount: 100, period_ids: [11] },
        COMPANY_ID,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rechaza con 404 si la fuente (banco) no existe o está archivada', async () => {
    const periods = [makePeriod({ id: '11', period_number: 1, amount: 100 })];
    const { manager } = buildManager({ periods, bank: null });
    const { action } = buildAction(manager);

    await expect(
      action.execute(
        FIXED_EXPENSE_ID,
        { source_type: 'bank', source_id: 5, amount: 100, period_ids: [11] },
        COMPANY_ID,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechaza con 404 si un period_id no pertenece al gasto', async () => {
    const periods = [makePeriod({ id: '11', period_number: 1, amount: 100 })];
    const { manager } = buildManager({ periods, bank: BANK(1000) });
    const { action } = buildAction(manager);

    // 99 no existe → selected.length (1) !== period_ids.length (2) → 404.
    await expect(
      action.execute(
        FIXED_EXPENSE_ID,
        { source_type: 'bank', source_id: 5, amount: 50, period_ids: [11, 99] },
        COMPANY_ID,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechaza con 404 si el gasto fijo no existe en la company', async () => {
    const periods: PeriodState[] = [];
    const { manager } = buildManager({ periods, bank: BANK(1000) });
    const { action } = buildAction(manager);

    await expect(
      action.execute(
        999, // gasto inexistente
        { source_type: 'bank', source_id: 5, amount: 50, period_ids: [11] },
        COMPANY_ID,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('usa Big.js: 0.1 + 0.2 sobre saldos no introduce error de coma flotante', async () => {
    const periods = [
      makePeriod({ id: '11', period_number: 1, amount: 0.1 }),
      makePeriod({ id: '12', period_number: 2, amount: 0.2 }),
    ];
    const { manager } = buildManager({ periods, bank: BANK(1000) });
    const { action } = buildAction(manager);

    const result = await action.execute(
      FIXED_EXPENSE_ID,
      { source_type: 'bank', source_id: 5, amount: 0.3, period_ids: [11, 12] },
      COMPANY_ID,
      ACTOR,
    );

    expect(result.paid_total).toBe(0.3);
    expect(periods[0].balance).toBe(0);
    expect(periods[1].balance).toBe(0);
    expect(new Big(periods[0].paid_amount).plus(periods[1].paid_amount).toString()).toBe('0.3');
  });
});
