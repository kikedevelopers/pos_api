import type { EntityManager } from 'typeorm';

import { APP_SETTING_KEYS } from '../entities/app-setting.entity';
import {
  assignNextTurn,
  clampTurnosMax,
  getTurnosConfig,
  TURNOS_DEFAULT_MAX,
} from '../internal/turnos-config';

const COMPANY_ID = 42;

/**
 * Mock de EntityManager:
 *   - `getRepository().findOne` para `getTurnosConfig` (por key).
 *   - `query` para `assignNextTurn`: SELECT enabled/max + INSERT ON CONFLICT.
 *   - `createQueryBuilder()` para el UPDATE cíclico (`.returning().execute()` →
 *     `{ raw }`), igual que IncrementTicketNumberAction.
 */
function buildManager(opts: {
  rows?: Partial<Record<string, string>>;
  select?: { enabled: string | null; max: string | null };
  updateRaw?: Array<{ value: string }>;
}): {
  manager: EntityManager;
  query: jest.Mock;
  createQueryBuilder: jest.Mock;
  getSetExpr: () => string;
} {
  const rows = opts.rows ?? {};
  const findOne = jest.fn(({ where }: { where: { key: string } }) =>
    Promise.resolve(rows[where.key] !== undefined ? { value: rows[where.key] } : null),
  );
  const query = jest.fn((sql: string) => {
    if (/^\s*SELECT/i.test(sql)) {
      return Promise.resolve([opts.select ?? { enabled: 'false', max: null }]);
    }
    return Promise.resolve([[], 0]); // INSERT ... ON CONFLICT DO NOTHING (tupla)
  });

  let setExpr = '';
  const execute = jest.fn(() =>
    Promise.resolve({ raw: opts.updateRaw ?? [{ value: '1' }] }),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qb: any = {
    update: jest.fn(() => qb),
    set: jest.fn((obj: { value: () => string }) => {
      setExpr = typeof obj.value === 'function' ? obj.value() : String(obj.value);
      return qb;
    }),
    where: jest.fn(() => qb),
    returning: jest.fn(() => qb),
    execute,
  };
  const createQueryBuilder = jest.fn(() => qb);

  const manager = {
    getRepository: () => ({ findOne }),
    query,
    createQueryBuilder,
  } as unknown as EntityManager;
  return { manager, query, createQueryBuilder, getSetExpr: () => setExpr };
}

describe('clampTurnosMax', () => {
  it('fuerza el rango [1, 99]', () => {
    expect(clampTurnosMax(0)).toBe(1);
    expect(clampTurnosMax(-5)).toBe(1);
    expect(clampTurnosMax(100)).toBe(99);
    expect(clampTurnosMax(50)).toBe(50);
  });
  it('trunca decimales y cae al default si no es finito', () => {
    expect(clampTurnosMax(50.9)).toBe(50);
    expect(clampTurnosMax(Number.NaN)).toBe(TURNOS_DEFAULT_MAX);
  });
});

describe('getTurnosConfig', () => {
  it('sin keys → defaults (off, max 99, counter 0)', async () => {
    const { manager } = buildManager({});
    await expect(getTurnosConfig(manager, COMPANY_ID)).resolves.toEqual({
      enabled: false,
      max: 99,
      counter: 0,
    });
  });

  it('parsea y clampa los valores guardados', async () => {
    const { manager } = buildManager({
      rows: {
        [APP_SETTING_KEYS.TURNOS_ENABLED]: 'true',
        [APP_SETTING_KEYS.TURNOS_MAX]: '150', // fuera de rango → 99
        [APP_SETTING_KEYS.TURNOS_COUNTER]: '7',
      },
    });
    await expect(getTurnosConfig(manager, COMPANY_ID)).resolves.toEqual({
      enabled: true,
      max: 99,
      counter: 7,
    });
  });
});

describe('assignNextTurn', () => {
  it('deshabilitado → null y NO toca el contador (sin INSERT ni UPDATE)', async () => {
    const { manager, query, createQueryBuilder } = buildManager({
      select: { enabled: 'false', max: null },
    });
    await expect(assignNextTurn(manager, COMPANY_ID)).resolves.toBeNull();
    // Solo corrió el SELECT de config; nunca el INSERT ni el UPDATE del contador.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^\s*SELECT/i);
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('NO usa Promise.all: lee la config en una sola query secuencial', async () => {
    const { manager, query } = buildManager({ select: { enabled: 'true', max: '50' } });
    await assignNextTurn(manager, COMPANY_ID);
    // 1ra query es el SELECT combinado (enabled + max), no 3 findOne paralelos.
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/^\s*SELECT/i);
    expect(params).toEqual([
      String(COMPANY_ID),
      APP_SETTING_KEYS.TURNOS_ENABLED,
      APP_SETTING_KEYS.TURNOS_MAX,
    ]);
  });

  it('habilitado → garantiza la fila (INSERT) e incrementa cíclico vía QueryBuilder', async () => {
    const { manager, query, createQueryBuilder, getSetExpr } = buildManager({
      select: { enabled: 'true', max: '50' },
      updateRaw: [{ value: '9' }],
    });

    await expect(assignNextTurn(manager, COMPANY_ID)).resolves.toBe(9);

    // El INSERT ON CONFLICT garantiza la fila del contador.
    expect(query.mock.calls[1][0]).toMatch(/INSERT INTO app_settings/i);
    expect(query.mock.calls[1][0]).toMatch(/ON CONFLICT .* DO NOTHING/i);

    // El UPDATE va por QueryBuilder (.returning().execute()) con el ciclo y el tope.
    expect(createQueryBuilder).toHaveBeenCalledTimes(1);
    const expr = getSetExpr();
    expect(expr).toMatch(/CASE WHEN coalesce\(value, '0'\)::int >= 50 THEN 1/i);
    expect(expr).toMatch(/ELSE coalesce\(value, '0'\)::int \+ 1 END/i);
  });

  it('lee el turno de `.raw` (no de la tupla [rows,count] de query)', async () => {
    const { manager } = buildManager({
      select: { enabled: 'true', max: '99' },
      updateRaw: [{ value: '42' }],
    });
    await expect(assignNextTurn(manager, COMPANY_ID)).resolves.toBe(42);
  });

  it('nunca devuelve NaN: `.raw` vacío → null (no revienta el INSERT del pedido)', async () => {
    const { manager } = buildManager({
      select: { enabled: 'true', max: '50' },
      updateRaw: [], // sin filas
    });
    await expect(assignNextTurn(manager, COMPANY_ID)).resolves.toBeNull();
  });
});
