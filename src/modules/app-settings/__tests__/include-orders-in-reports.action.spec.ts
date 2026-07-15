import type { DataSource, EntityManager } from 'typeorm';

import { GetIncludeOrdersInReportsAction } from '../actions/get-include-orders-in-reports.action';
import { UpsertIncludeOrdersInReportsAction } from '../actions/upsert-include-orders-in-reports.action';
import { APP_SETTING_KEYS } from '../entities/app-setting.entity';

/**
 * Tests unitarios de las actions del flag `include_orders_in_reports`.
 *
 * Cubre:
 *   - GET: default false cuando la key no existe; true/false según el value.
 *   - UPSERT: value 'true'/'false' según `enabled`; rama create (no existe) y
 *     rama update (ya existe); siempre scopeado por company_id + key.
 */
describe('GetIncludeOrdersInReportsAction', () => {
  let findOneSpy: jest.Mock;
  let action: GetIncludeOrdersInReportsAction;

  beforeEach(() => {
    findOneSpy = jest.fn();
    const dataSourceMock = {
      getRepository: jest.fn().mockReturnValue({ findOne: findOneSpy }),
    } as unknown as DataSource;
    action = new GetIncludeOrdersInReportsAction(dataSourceMock);
  });

  it('default false cuando la key NO existe', async () => {
    findOneSpy.mockResolvedValue(null);
    await expect(action.execute(42)).resolves.toEqual({ enabled: false });
  });

  it("enabled=true cuando value = 'true'", async () => {
    findOneSpy.mockResolvedValue({ value: 'true' });
    await expect(action.execute(42)).resolves.toEqual({ enabled: true });
  });

  it("enabled=false cuando value = 'false' (o cualquier otro string)", async () => {
    findOneSpy.mockResolvedValue({ value: 'false' });
    await expect(action.execute(42)).resolves.toEqual({ enabled: false });
  });

  it('filtra por company_id + key include_orders_in_reports', async () => {
    findOneSpy.mockResolvedValue(null);
    await action.execute(7);
    expect(findOneSpy).toHaveBeenCalledWith({
      where: {
        company_id: '7',
        key: APP_SETTING_KEYS.INCLUDE_ORDERS_IN_REPORTS,
      },
    });
  });
});

describe('UpsertIncludeOrdersInReportsAction', () => {
  let managerMock: {
    findOne: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
  };
  let action: UpsertIncludeOrdersInReportsAction;

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
    action = new UpsertIncludeOrdersInReportsAction(dataSourceMock);
  });

  it('INSERTA con value="true" cuando enabled=true y la key no existe', async () => {
    managerMock.findOne.mockResolvedValue(null);
    await expect(action.execute({ enabled: true }, 42)).resolves.toEqual({ enabled: true });
    expect(managerMock.insert).toHaveBeenCalledWith(expect.anything(), {
      company_id: '42',
      key: APP_SETTING_KEYS.INCLUDE_ORDERS_IN_REPORTS,
      value: 'true',
    });
    expect(managerMock.update).not.toHaveBeenCalled();
  });

  it('INSERTA con value="false" cuando enabled=false y la key no existe', async () => {
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
