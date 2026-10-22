import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DataSource } from 'typeorm';

import { REQUIRE_PERMISSION_KEY } from '@/common/decorators/require-permission.decorator';

import {
  GetPayablesAction,
  PAYABLES_DEFAULT_LIMIT,
  PAYABLES_DUE_SOON_DAYS,
} from '../actions/get-payables.action';
import { DashboardController } from '../dashboard.controller';
import { DashboardPayablesQueryDto } from '../dto/dashboard-query.dto';

/**
 * Compras por pagar del dashboard.
 *
 *   - Universo: purchase_credits no PAID con saldo, compra no eliminada.
 *   - Aislamiento multi-tenant en ambas tablas.
 *   - Orden: vence primero arriba, sin plazo al final.
 *   - Tramos: vencida (< now), pronto (< inicio de hoy + 7 días Bogotá), posterior, sin plazo.
 *   - Mapeo: ids numéricos, montos redondeados, fechas ISO / día plano.
 */
describe('GetPayablesAction', () => {
  // 22-oct-2026 10:00 en Bogotá (UTC-5).
  const NOW = new Date('2026-10-22T15:00:00.000Z');

  const EMPTY_TOTALS = {
    count: '0',
    balance: '0',
    overdue_count: '0',
    overdue_balance: '0',
    due_soon_count: '0',
    due_soon_balance: '0',
    upcoming_count: '0',
    upcoming_balance: '0',
    no_due_count: '0',
    no_due_balance: '0',
  };

  /** La primera query es la de filas (LIMIT), la segunda la de totales. */
  interface QueryCall {
    sql: string;
    params: unknown[];
  }

  function makeAction(items: unknown[], totals: unknown[] = [EMPTY_TOTALS]) {
    const query = jest.fn((sql: string, _params?: unknown[]) =>
      Promise.resolve(sql.includes('LIMIT $2') ? items : totals),
    );
    const action = new GetPayablesAction({ query } as unknown as DataSource);
    const calls = (): QueryCall[] =>
      query.mock.calls.map(([sql, params]) => ({ sql, params: params ?? [] }));
    const pick = (isItems: boolean): QueryCall => {
      const found = calls().find((c) => c.sql.includes('LIMIT $2') === isItems);
      if (!found) {
        throw new Error(`No se emitió la query de ${isItems ? 'filas' : 'totales'}`);
      }
      return found;
    };
    return {
      action,
      query,
      calls,
      itemsCall: (): QueryCall => pick(true),
      totalsCall: (): QueryCall => pick(false),
    };
  }

  it('cada query filtra por company_id = $1 en purchase_credits y purchases', async () => {
    const { action, calls } = makeAction([]);
    await action.execute(42, 10, NOW);

    expect(calls()).toHaveLength(2);
    for (const c of calls()) {
      expect(c.sql).toMatch(/pc\.company_id\s*=\s*\$1/);
      expect(c.sql).toMatch(/p\.company_id\s*=\s*\$1/);
      expect(c.params[0]).toBe('42');
      const placeholders = c.sql.match(/company_id\s*=\s*\$\d+/g) ?? [];
      for (const m of placeholders) {
        expect(m).toMatch(/\$1$/);
      }
    }
  });

  it('solo considera créditos no pagados con saldo y compras no eliminadas', async () => {
    const { action, calls } = makeAction([]);
    await action.execute(1, 10, NOW);

    for (const c of calls()) {
      expect(c.sql).toMatch(/pc\.status\s*<>\s*'PAID'/);
      expect(c.sql).toMatch(/pc\.balance\s*>\s*0/);
      expect(c.sql).toMatch(/p\.is_deleted\s*=\s*false/);
    }
  });

  it('ordena de la que vence primero a la última, sin plazo al final', async () => {
    const { action, itemsCall } = makeAction([]);
    await action.execute(1, 10, NOW);

    const itemsSql = itemsCall().sql;
    expect(itemsSql).toMatch(
      /ORDER BY p\.payment_due_at ASC NULLS LAST, p\.created_at ASC, p\.id ASC/,
    );
  });

  it('pasa el limit a la query de filas y usa el default si no llega', async () => {
    const { action, itemsCall } = makeAction([]);
    await action.execute(1, 25, NOW);
    expect(itemsCall().params).toEqual(['1', 25]);

    const second = makeAction([]);
    await second.action.execute(1, undefined, NOW);
    expect(second.itemsCall().params).toEqual(['1', PAYABLES_DEFAULT_LIMIT]);
  });

  it('los totales no se limitan y usan now + inicio del día (hoy + 7) en Bogotá', async () => {
    const { action, totalsCall } = makeAction([]);
    await action.execute(1, 3, NOW);

    const totals = totalsCall();
    expect(totals.sql).not.toMatch(/LIMIT/);
    expect(totals.params[1]).toBe(NOW);
    // 29-oct-2026 00:00 Bogotá = 05:00 UTC → vencen hasta el 28 (7 días con hoy).
    expect((totals.params[2] as Date).toISOString()).toBe('2026-10-29T05:00:00.000Z');
  });

  it('el límite de "pronto" respeta el día de Bogotá aunque en UTC ya sea mañana', async () => {
    const { action, totalsCall } = makeAction([]);
    // 22-oct 22:30 Bogotá = 23-oct 03:30 UTC: sigue siendo 22 en Colombia.
    await action.execute(1, 10, new Date('2026-10-23T03:30:00.000Z'));

    const totals = totalsCall();
    expect((totals.params[2] as Date).toISOString()).toBe('2026-10-29T05:00:00.000Z');
  });

  it('define los tramos con los mismos límites que el front', async () => {
    const { action, totalsCall } = makeAction([]);
    await action.execute(1, 10, NOW);

    const sql = totalsCall().sql;
    expect(sql).toMatch(/FILTER \(WHERE p\.payment_due_at < \$2\) AS overdue_count/);
    expect(sql).toMatch(
      /FILTER \(WHERE p\.payment_due_at >= \$2 AND p\.payment_due_at < \$3\) AS due_soon_count/,
    );
    expect(sql).toMatch(/FILTER \(WHERE p\.payment_due_at >= \$3\) AS upcoming_count/);
    expect(sql).toMatch(/FILTER \(WHERE p\.payment_due_at IS NULL\) AS no_due_count/);
  });

  it('mapea filas: ids numéricos, montos a 2 decimales y fechas normalizadas', async () => {
    const { action } = makeAction([
      {
        id: '7',
        purchase_number: 'COMP-007',
        supplier_id: '3',
        supplier_name: 'Especias del Valle',
        invoice_number: 'FV-118',
        invoice_date: '2026-10-01',
        payment_due_at: new Date('2026-10-21T04:59:59.999Z'),
        total: '1500000.00',
        paid: '500000.005',
        balance: '999999.995',
      },
      {
        id: '9',
        purchase_number: 'COMP-009',
        supplier_id: '4',
        supplier_name: 'Granos SAS',
        invoice_number: null,
        invoice_date: null,
        payment_due_at: null,
        total: '3450',
        paid: '0',
        balance: '3450',
      },
    ]);

    const result = await action.execute(1, 10, NOW);

    expect(result.items).toEqual([
      {
        purchase_id: 7,
        purchase_number: 'COMP-007',
        supplier_id: 3,
        supplier_name: 'Especias del Valle',
        invoice_number: 'FV-118',
        invoice_date: '2026-10-01',
        payment_due_at: '2026-10-21T04:59:59.999Z',
        total: 1500000,
        paid: 500000.01,
        balance: 1000000,
      },
      {
        purchase_id: 9,
        purchase_number: 'COMP-009',
        supplier_id: 4,
        supplier_name: 'Granos SAS',
        invoice_number: null,
        invoice_date: null,
        payment_due_at: null,
        total: 3450,
        paid: 0,
        balance: 3450,
      },
    ]);
  });

  it('expone los totales por tramo y la ventana de "pronto"', async () => {
    const { action } = makeAction(
      [],
      [
        {
          count: '5',
          balance: '7683654.66',
          overdue_count: '2',
          overdue_balance: '1200000.10',
          due_soon_count: '1',
          due_soon_balance: '483654.555',
          upcoming_count: '1',
          upcoming_balance: '5000000',
          no_due_count: 1,
          no_due_balance: '1000000.00',
        },
      ],
    );

    const result = await action.execute(1, 10, NOW);

    expect(result.due_soon_days).toBe(PAYABLES_DUE_SOON_DAYS);
    expect(result.totals).toEqual({
      count: 5,
      balance: 7683654.66,
      overdue: { count: 2, balance: 1200000.1 },
      due_soon: { count: 1, balance: 483654.56 },
      upcoming: { count: 1, balance: 5000000 },
      no_due: { count: 1, balance: 1000000 },
    });
  });

  it('sin compras por pagar devuelve lista vacía y totales en cero', async () => {
    const { action } = makeAction([], []);
    const result = await action.execute(1, 10, NOW);

    expect(result.items).toEqual([]);
    expect(result.totals).toEqual({
      count: 0,
      balance: 0,
      overdue: { count: 0, balance: 0 },
      due_soon: { count: 0, balance: 0 },
      upcoming: { count: 0, balance: 0 },
      no_due: { count: 0, balance: 0 },
    });
  });

  it('propaga el error de la base de datos', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection lost'));
    const action = new GetPayablesAction({ query } as unknown as DataSource);
    await expect(action.execute(1, 10, NOW)).rejects.toThrow('connection lost');
  });
});

describe('DashboardPayablesQueryDto', () => {
  const errorsFor = async (input: Record<string, unknown>) =>
    validate(plainToInstance(DashboardPayablesQueryDto, input));

  it('acepta limit omitido o entre 1 y 100 (string de query incluido)', async () => {
    expect(await errorsFor({})).toHaveLength(0);
    expect(await errorsFor({ limit: '1' })).toHaveLength(0);
    expect(await errorsFor({ limit: '100' })).toHaveLength(0);
  });

  it.each([['0'], ['101'], ['2.5'], ['abc'], ['-3']])('rechaza limit=%s', async (limit) => {
    expect((await errorsFor({ limit })).length).toBeGreaterThan(0);
  });
});

describe('DashboardController#payables (permisos)', () => {
  it('exige canAccessPurchase además de canAccessDashboard del controller', () => {
    const handler = Object.getOwnPropertyDescriptor(DashboardController.prototype, 'payables')
      ?.value as object;
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('canAccessPurchase');
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, DashboardController)).toBe(
      'canAccessDashboard',
    );
  });
});
