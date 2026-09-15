import type { DataSource, EntityManager } from 'typeorm';

import { GetShowDailyQuotaBarAction } from '../actions/get-show-daily-quota-bar.action';
import { UpsertShowDailyQuotaBarAction } from '../actions/upsert-show-daily-quota-bar.action';
import { APP_SETTING_KEYS } from '../entities/app-setting.entity';

/**
 * Tests unitarios de las actions del flag `show_daily_quota_bar` (barra de cuota
 * diaria del POS).
 *
 * Cubre: GET default false cuando la key no existe (los negocios existentes no
 * necesitan backfill) y true/false según value; UPSERT rama create/update,
 * siempre scopeado por company_id + key.
 */
describe('GetShowDailyQuotaBarAction', () => {
  let findOneSpy: jest.Mock;
  let action: GetShowDailyQuotaBarAction;

  beforeEach(() => {
    findOneSpy = jest.fn();
    const dataSourceMock = {
      getRepository: jest.fn().mockReturnValue({ findOne: findOneSpy }),
    } as unknown as DataSource;
    action = new GetShowDailyQuotaBarAction(dataSourceMock);
  });

  it('default false cuando la key NO existe (viene oculta)', async () => {
    findOneSpy.mockResolvedValue(null);
    await expect(action.execute(42)).resolves.toEqual({ enabled: false });
  });

  it("enabled=true cuando value = 'true'", async () => {
    findOneSpy.mockResolvedValue({ value: 'true' });
    await expect(action.execute(42)).resolves.toEqual({ enabled: true });
  });

  it("enabled=false para 'false' o cualquier otro string", async () => {
    findOneSpy.mockResolvedValue({ value: 'false' });
    await expect(action.execute(42)).resolves.toEqual({ enabled: false });
  });

  it('filtra por company_id + key show_daily_quota_bar', async () => {
    findOneSpy.mockResolvedValue(null);
    await action.execute(7);
    expect(findOneSpy).toHaveBeenCalledWith({
      where: {
        company_id: '7',
        key: APP_SETTING_KEYS.SHOW_DAILY_QUOTA_BAR,
      },
    });
  });
});

describe('UpsertShowDailyQuotaBarAction', () => {
  let managerMock: {
    findOne: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
  };
  let action: UpsertShowDailyQuotaBarAction;

  beforeEach(() => {
    managerMock = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    const dataSourceMock = {
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(managerMock as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    action = new UpsertShowDailyQuotaBarAction(dataSourceMock);
  });

  it('INSERTA value="true" cuando enabled=true y la key no existe', async () => {
    managerMock.findOne.mockResolvedValue(null);
    await expect(action.execute({ enabled: true }, 42)).resolves.toEqual({ enabled: true });
    expect(managerMock.insert).toHaveBeenCalledWith(expect.anything(), {
      company_id: '42',
      key: APP_SETTING_KEYS.SHOW_DAILY_QUOTA_BAR,
      value: 'true',
    });
    expect(managerMock.update).not.toHaveBeenCalled();
  });

  it('INSERTA value="false" cuando enabled=false y la key no existe', async () => {
    managerMock.findOne.mockResolvedValue(null);
    await expect(action.execute({ enabled: false }, 42)).resolves.toEqual({ enabled: false });
    expect(managerMock.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ value: 'false' }),
    );
  });

  it('ACTUALIZA (no inserta) cuando la key ya existe', async () => {
    managerMock.findOne.mockResolvedValue({ id: '9' });
    await expect(action.execute({ enabled: true }, 42)).resolves.toEqual({ enabled: true });
    expect(managerMock.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: '9', company_id: '42' },
      { value: 'true' },
    );
    expect(managerMock.insert).not.toHaveBeenCalled();
  });
});
