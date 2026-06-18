import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { dayjs, APP_TIMEZONE } from '@/common/utils/dayjs';
import { RealtimeGateway } from '@/modules/realtime/realtime.gateway';

import { SyncDuePeriodsAction } from '../actions/sync-due-periods.action';
import {
  calendarAnchorsAfter,
  calendarCompletedPeriods,
  dueAtForPeriod,
  expectedCompletedPeriods,
  isCalendarPeriodUnit,
  type ScheduleExpense,
} from '../internal/period-schedule';
import { FixedExpense, type FixedExpensePeriodUnit } from '../entities/fixed-expense.entity';
import { FixedExpensePeriod } from '../entities/fixed-expense-period.entity';
import { AppAlert } from '@/modules/app-alerts/entities/app-alert.entity';

/**
 * Tests del SYNC de cortes (Camino A — gastos fijos alineados al calendario).
 *
 * Dos bloques:
 *   1. Algoritmo canónico §2 con los vectores §3 (V1–V5) del contrato
 *      `CONTRACT_fixed_expenses_calendar.md`. Estos DEBEN coincidir byte a byte
 *      con `placepos/src/renderer` y `placepos/src/main`.
 *   2. `SyncDuePeriodsAction`: idempotencia (ON CONFLICT DO NOTHING), generación
 *      de alerta por corte nuevo, cooldown lazy vs. `force`.
 */

/** Instante de un anclaje Bogotá: día 15 → endOf('day'); fin de mes → endOf('month'). */
const day15 = (ym: string): Date => dayjs.tz(`${ym}-15`, APP_TIMEZONE).endOf('day').toDate();
const endOfMonth = (ym: string): Date =>
  dayjs.tz(`${ym}-01`, APP_TIMEZONE).endOf('month').toDate();
/** Medianoche local Bogotá de una fecha (para `start_date`). */
const startAt = (date: string): Date => dayjs.tz(`${date} 00:00:00`, APP_TIMEZONE).toDate();

const isoList = (dates: Date[]): string[] => dates.map((d) => d.toISOString());

describe('Algoritmo canónico §2 — vectores §3 (V1–V5)', () => {
  it('V1 — Mensual (end_of_month), start 2026-01-10', () => {
    const start = startAt('2026-01-10');
    const anchors = calendarAnchorsAfter({ period_unit: 'end_of_month', start_date: start }, 4);
    expect(isoList(anchors)).toEqual(
      isoList([endOfMonth('2026-01'), endOfMonth('2026-02'), endOfMonth('2026-03'), endOfMonth('2026-04')]),
    );

    // amount(n) = completo SIEMPRE; due_at(n) = a_n.
    const schedule: ScheduleExpense = {
      period_unit: 'end_of_month',
      period_quantity: 1,
      start_date: start,
      amount: 1_000_000,
    };
    expect(dueAtForPeriod(schedule, 2).toISOString()).toBe(endOfMonth('2026-02').toISOString());

    // now=2026-02-15 12:00 → completed=1.
    const now = dayjs.tz('2026-02-15 12:00:00', APP_TIMEZONE).toDate();
    expect(calendarCompletedPeriods({ period_unit: 'end_of_month', start_date: start }, now)).toBe(1);
  });

  it('V2 — Quincenal (semimonthly), start 2026-02-01', () => {
    const start = startAt('2026-02-01');
    const anchors = calendarAnchorsAfter({ period_unit: 'semimonthly', start_date: start }, 4);
    expect(isoList(anchors)).toEqual(
      isoList([day15('2026-02'), endOfMonth('2026-02'), day15('2026-03'), endOfMonth('2026-03')]),
    );
  });

  it('V3 — Quincenal, start 2026-02-20 (omite día 15 anterior al start)', () => {
    const start = startAt('2026-02-20');
    const anchors = calendarAnchorsAfter({ period_unit: 'semimonthly', start_date: start }, 3);
    expect(isoList(anchors)).toEqual(
      isoList([endOfMonth('2026-02'), day15('2026-03'), endOfMonth('2026-03')]),
    );
  });

  it('V4 — Quincenal, año bisiesto, start 2024-02-01 (febrero = 29)', () => {
    const start = startAt('2024-02-01');
    const anchors = calendarAnchorsAfter({ period_unit: 'semimonthly', start_date: start }, 3);
    expect(isoList(anchors)).toEqual(
      isoList([day15('2024-02'), endOfMonth('2024-02'), day15('2024-03')]),
    );
    // El fin de febrero 2024 debe ser el 29 (no el 28).
    expect(endOfMonth('2024-02').toISOString()).toBe(anchors[1].toISOString());
    expect(dayjs(anchors[1]).tz(APP_TIMEZONE).date()).toBe(29);
  });

  it('V5 — Mensual, start exactamente en un anclaje (2026-01-31) → no dispara ese corte', () => {
    // start = 2026-01-31 23:59:59.999 Bogotá (el anclaje mismo).
    const start = dayjs.tz('2026-01-31', APP_TIMEZONE).endOf('day').toDate();
    const anchors = calendarAnchorsAfter({ period_unit: 'end_of_month', start_date: start }, 1);
    // a1 NO es 2026-01-31 (anchor > start estricto); es 2026-02-28.
    expect(anchors[0].toISOString()).toBe(endOfMonth('2026-02').toISOString());
  });

  it('legacy (month=30 días fijos) conserva el cálculo de horas — no usa calendario', () => {
    expect(isCalendarPeriodUnit('month' as FixedExpensePeriodUnit)).toBe(false);
    const start = startAt('2026-01-01');
    const schedule: ScheduleExpense = {
      period_unit: 'month',
      period_quantity: 1,
      start_date: start,
      amount: 500_000,
    };
    // due_at(1) = start + 30 días exactos.
    const expected = new Date(start.getTime() + 30 * 24 * 3_600_000);
    expect(dueAtForPeriod(schedule, 1).toISOString()).toBe(expected.toISOString());
    // 45 días después → 1 corte completado (floor(45/30)).
    const now = new Date(start.getTime() + 45 * 24 * 3_600_000);
    expect(expectedCompletedPeriods(schedule, now)).toBe(1);
  });
});

describe('SyncDuePeriodsAction', () => {
  /** Construye un mock de EntityManager que simula INSERT con ON CONFLICT. */
  function buildManagerMock(opts: {
    existingPeriodNumbers: Set<number>;
    conflictingPeriodNumbers?: Set<number>;
  }) {
    const insertedPeriods: Array<Partial<FixedExpensePeriod>> = [];
    const savedAlerts: Array<Partial<AppAlert>> = [];
    const periodAlertUpdates: Array<{ periodId: string; alertId: string }> = [];
    let alertSeq = 0;
    let periodSeq = 0;

    const insertBuilder = {
      _values: null as Partial<FixedExpensePeriod> | null,
      insert() {
        return this;
      },
      into() {
        return this;
      },
      values(v: Partial<FixedExpensePeriod>) {
        this._values = v;
        return this;
      },
      orIgnore() {
        return this;
      },
      returning() {
        return this;
      },
      execute() {
        const v = this._values as Partial<FixedExpensePeriod>;
        const n = v.period_number as number;
        const conflict = opts.conflictingPeriodNumbers?.has(n) ?? false;
        if (conflict) {
          return Promise.resolve({ raw: [] });
        }
        periodSeq += 1;
        const id = String(periodSeq);
        insertedPeriods.push(v);
        return Promise.resolve({ raw: [{ id }] });
      },
    };

    const manager = {
      createQueryBuilder: jest.fn(() => insertBuilder),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === AppAlert) {
          return {
            save: jest.fn((alert: Partial<AppAlert>) => {
              alertSeq += 1;
              const withId = { ...alert, id: String(1000 + alertSeq) };
              savedAlerts.push(withId);
              return Promise.resolve(withId);
            }),
          };
        }
        return {};
      }),
      create: jest.fn((_entity: unknown, data: unknown) => data),
      update: jest.fn((_entity: unknown, periodId: string, patch: { alert_id: string }) => {
        periodAlertUpdates.push({ periodId, alertId: patch.alert_id });
        return Promise.resolve(undefined);
      }),
    };

    return { manager, insertedPeriods, savedAlerts, periodAlertUpdates };
  }

  function buildAction(opts: {
    expense: Partial<FixedExpense>;
    existingPeriodNumbers: Set<number>;
    conflictingPeriodNumbers?: Set<number>;
  }) {
    const mocks = buildManagerMock(opts);

    const findFns: Record<string, unknown> = {};
    // Repo de FixedExpense (lista de gastos activos de la company).
    const expenseRepo = {
      find: jest.fn().mockResolvedValue([opts.expense]),
    };
    // Repo de FixedExpensePeriod (period_number existentes).
    const periodRepo = {
      find: jest.fn().mockResolvedValue(
        [...opts.existingPeriodNumbers].map((period_number) => ({ period_number })),
      ),
    };

    const dataSourceMock = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === FixedExpense) return expenseRepo;
        if (entity === FixedExpensePeriod) return periodRepo;
        return {};
      }),
      transaction: jest.fn(async <T>(cb: (m: typeof mocks.manager) => Promise<T>) =>
        cb(mocks.manager),
      ),
    };

    return { dataSourceMock, mocks, expenseRepo, periodRepo, findFns };
  }

  it('materializa cortes vencidos y crea una alerta por cada corte nuevo', async () => {
    // Quincenal, start 2026-02-01, now bien adelante → 2 cortes en febrero.
    const expense: Partial<FixedExpense> = {
      id: '10',
      company_id: '7',
      name: 'Nómina',
      amount: 1_100_000,
      period_unit: 'semimonthly',
      period_quantity: 1,
      start_date: startAt('2026-02-01'),
      is_archived: false,
    };
    const { dataSourceMock, mocks } = buildAction({
      expense,
      existingPeriodNumbers: new Set(),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncDuePeriodsAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: RealtimeGateway, useValue: { emitAlertCreated: jest.fn() } },
      ],
    }).compile();
    const action = module.get(SyncDuePeriodsAction);

    const now = dayjs.tz('2026-03-01 00:00:00', APP_TIMEZONE).toDate();
    const result = await action.execute(7, now, { force: true });

    // Cortes de febrero: a1=15, a2=28 → 2 cortes vencidos al 2026-03-01.
    expect(result.createdPeriods).toBe(2);
    expect(result.skipped).toBe(false);
    expect(mocks.insertedPeriods).toHaveLength(2);
    // amount(n) = completo SIEMPRE.
    expect(mocks.insertedPeriods.every((p) => p.amount === 1_100_000)).toBe(true);
    // due_at(1)=15 feb, due_at(2)=28 feb.
    expect(mocks.insertedPeriods[0].due_at?.toISOString()).toBe(day15('2026-02').toISOString());
    expect(mocks.insertedPeriods[1].due_at?.toISOString()).toBe(
      endOfMonth('2026-02').toISOString(),
    );
    // Una alerta por corte, enlazada vía alert_id.
    expect(mocks.savedAlerts).toHaveLength(2);
    expect(mocks.periodAlertUpdates).toHaveLength(2);
    expect(mocks.savedAlerts[0].company_id).toBe('7');
    expect(mocks.savedAlerts[0].type).toBe('FIXED_EXPENSE_DUE');
    expect((mocks.savedAlerts[0].metadata as { period_number: number }).period_number).toBe(1);
  });

  it('es idempotente: no recrea cortes existentes ni emite alertas para ellos', async () => {
    const expense: Partial<FixedExpense> = {
      id: '10',
      company_id: '7',
      name: 'Nómina',
      amount: 1_100_000,
      period_unit: 'semimonthly',
      period_quantity: 1,
      start_date: startAt('2026-02-01'),
      is_archived: false,
    };
    // El corte 1 ya existe → solo se crea el corte 2.
    const { dataSourceMock, mocks } = buildAction({
      expense,
      existingPeriodNumbers: new Set([1]),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncDuePeriodsAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: RealtimeGateway, useValue: { emitAlertCreated: jest.fn() } },
      ],
    }).compile();
    const action = module.get(SyncDuePeriodsAction);

    const now = dayjs.tz('2026-03-01 00:00:00', APP_TIMEZONE).toDate();
    const result = await action.execute(7, now, { force: true });

    expect(result.createdPeriods).toBe(1);
    expect(mocks.insertedPeriods).toHaveLength(1);
    expect(mocks.insertedPeriods[0].period_number).toBe(2);
    expect(mocks.savedAlerts).toHaveLength(1);
  });

  it('ON CONFLICT DO NOTHING (carrera): no crea alerta huérfana', async () => {
    const expense: Partial<FixedExpense> = {
      id: '10',
      company_id: '7',
      name: 'Nómina',
      amount: 1_100_000,
      period_unit: 'semimonthly',
      period_quantity: 1,
      start_date: startAt('2026-02-01'),
      is_archived: false,
    };
    // El corte 1 no figura como existente al leer, pero otro proceso lo insertó
    // primero → el INSERT con ON CONFLICT devuelve raw=[] → sin alerta.
    const { dataSourceMock, mocks } = buildAction({
      expense,
      existingPeriodNumbers: new Set(),
      conflictingPeriodNumbers: new Set([1]),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncDuePeriodsAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: RealtimeGateway, useValue: { emitAlertCreated: jest.fn() } },
      ],
    }).compile();
    const action = module.get(SyncDuePeriodsAction);

    const now = dayjs.tz('2026-03-01 00:00:00', APP_TIMEZONE).toDate();
    const result = await action.execute(7, now, { force: true });

    // Corte 1 en conflicto (no cuenta), corte 2 sí se crea.
    expect(result.createdPeriods).toBe(1);
    expect(mocks.savedAlerts).toHaveLength(1);
    expect(mocks.savedAlerts[0] && (mocks.savedAlerts[0].metadata as { period_number: number }).period_number).toBe(2);
  });

  it('respeta el cooldown lazy por company y lo ignora con force', async () => {
    const expense: Partial<FixedExpense> = {
      id: '10',
      company_id: '7',
      name: 'Nómina',
      amount: 1_100_000,
      period_unit: 'end_of_month',
      period_quantity: 1,
      start_date: startAt('2030-01-01'), // futuro → cero cortes
      is_archived: false,
    };
    const { dataSourceMock } = buildAction({ expense, existingPeriodNumbers: new Set() });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncDuePeriodsAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: RealtimeGateway, useValue: { emitAlertCreated: jest.fn() } },
      ],
    }).compile();
    const action = module.get(SyncDuePeriodsAction);

    const now = new Date();
    const first = await action.execute(7, now); // lazy, primera corrida
    expect(first.skipped).toBe(false);

    const second = await action.execute(7, now); // lazy dentro del cooldown
    expect(second.skipped).toBe(true);

    const forced = await action.execute(7, now, { force: true }); // ignora cooldown
    expect(forced.skipped).toBe(false);

    // Otra company NO comparte cooldown.
    const otherCompany = await action.execute(99, now);
    expect(otherCompany.skipped).toBe(false);
  });
});
