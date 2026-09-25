import type { DataSource, EntityManager } from 'typeorm';

import { GetEnableThirdPartyLoanAction } from '../actions/get-enable-third-party-loan.action';
import { UpsertEnableThirdPartyLoanAction } from '../actions/upsert-enable-third-party-loan.action';
import { APP_SETTING_KEYS } from '../entities/app-setting.entity';

/**
 * Tests de las actions del flag `enable_third_party_loan` (habilita el medio
 * "Préstamo a Tercero").
 *
 * Clave: el DEFAULT es FALSE (feature apagada). Es la fuente que el backend
 * revalida (fail-closed) antes de convertir un pedido en préstamo.
 */
describe('GetEnableThirdPartyLoanAction', () => {
  let findOneSpy: jest.Mock;
  let action: GetEnableThirdPartyLoanAction;

  beforeEach(() => {
    findOneSpy = jest.fn();
    const dataSourceMock = {
      getRepository: jest.fn().mockReturnValue({ findOne: findOneSpy }),
    } as unknown as DataSource;
    action = new GetEnableThirdPartyLoanAction(dataSourceMock);
  });

  it('default FALSE cuando la key NO existe (feature apagada)', async () => {
    findOneSpy.mockResolvedValue(null);
    await expect(action.execute(42)).resolves.toEqual({ enabled: false });
  });

  it("enabled=true SOLO con un 'true' explícito", async () => {
    findOneSpy.mockResolvedValue({ value: 'true' });
    await expect(action.execute(42)).resolves.toEqual({ enabled: true });
  });

  it("enabled=false para 'false' o cualquier otro string", async () => {
    findOneSpy.mockResolvedValue({ value: 'nope' });
    await expect(action.execute(42)).resolves.toEqual({ enabled: false });
  });

  it('filtra por company_id + key enable_third_party_loan', async () => {
    findOneSpy.mockResolvedValue(null);
    await action.execute(7);
    expect(findOneSpy).toHaveBeenCalledWith({
      where: { company_id: '7', key: APP_SETTING_KEYS.ENABLE_THIRD_PARTY_LOAN },
    });
  });
});

describe('UpsertEnableThirdPartyLoanAction', () => {
  let managerMock: { findOne: jest.Mock; update: jest.Mock; insert: jest.Mock };
  let action: UpsertEnableThirdPartyLoanAction;

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
    action = new UpsertEnableThirdPartyLoanAction(dataSourceMock);
  });

  it('INSERTA value="true" cuando enabled=true y la key no existe', async () => {
    managerMock.findOne.mockResolvedValue(null);
    await expect(action.execute({ enabled: true }, 42)).resolves.toEqual({ enabled: true });
    expect(managerMock.insert).toHaveBeenCalledWith(expect.anything(), {
      company_id: '42',
      key: APP_SETTING_KEYS.ENABLE_THIRD_PARTY_LOAN,
      value: 'true',
    });
    expect(managerMock.update).not.toHaveBeenCalled();
  });

  it('ACTUALIZA (no inserta) cuando la key ya existe', async () => {
    managerMock.findOne.mockResolvedValue({ id: '3' });
    await expect(action.execute({ enabled: false }, 42)).resolves.toEqual({ enabled: false });
    expect(managerMock.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: '3', company_id: '42' },
      { value: 'false' },
    );
    expect(managerMock.insert).not.toHaveBeenCalled();
  });
});
