import type { DataSource, EntityManager } from 'typeorm';

import { GetTurnosAction } from '../actions/get-turnos.action';
import { ResetTurnosCounterAction } from '../actions/reset-turnos-counter.action';
import { UpsertTurnosAction } from '../actions/upsert-turnos.action';
import { APP_SETTING_KEYS } from '../entities/app-setting.entity';

const COMPANY_ID = 42;

/**
 * Mock de DataSource con un store en memoria para `app_settings`. `upsert`
 * escribe por (company_id, key); `findOne` lee; `transaction` corre el callback
 * con el mismo manager.
 */
function buildDataSource(initial: Record<string, string> = {}): DataSource {
  const store = new Map<string, string>(Object.entries(initial));
  const repo = {
    findOne: jest.fn(({ where }: { where: { key: string } }) =>
      Promise.resolve(store.has(where.key) ? { value: store.get(where.key) } : null),
    ),
    upsert: jest.fn((rows: Array<{ key: string; value: string }>) => {
      for (const r of rows) store.set(r.key, r.value);
      return Promise.resolve();
    }),
  };
  const manager = { getRepository: () => repo } as unknown as EntityManager;
  return {
    manager,
    transaction: jest.fn((cb: (m: EntityManager) => unknown) => cb(manager)),
  } as unknown as DataSource;
}

describe('GetTurnosAction', () => {
  it('devuelve defaults si no hay keys', async () => {
    const action = new GetTurnosAction(buildDataSource());
    await expect(action.execute(COMPANY_ID)).resolves.toEqual({
      enabled: false,
      max: 99,
      counter: 0,
    });
  });
});

describe('UpsertTurnosAction', () => {
  it('persiste enabled + max (clampeado) y devuelve la config con el counter intacto', async () => {
    const ds = buildDataSource({ [APP_SETTING_KEYS.TURNOS_COUNTER]: '12' });
    const action = new UpsertTurnosAction(ds);
    const result = await action.execute({ enabled: true, max: 50 }, COMPANY_ID);
    expect(result).toEqual({ enabled: true, max: 50, counter: 12 });
  });
});

describe('ResetTurnosCounterAction', () => {
  it('pone el contador en 0 sin tocar enabled/max', async () => {
    const ds = buildDataSource({
      [APP_SETTING_KEYS.TURNOS_ENABLED]: 'true',
      [APP_SETTING_KEYS.TURNOS_MAX]: '30',
      [APP_SETTING_KEYS.TURNOS_COUNTER]: '25',
    });
    const action = new ResetTurnosCounterAction(ds);
    await expect(action.execute(COMPANY_ID)).resolves.toEqual({
      enabled: true,
      max: 30,
      counter: 0,
    });
  });
});
