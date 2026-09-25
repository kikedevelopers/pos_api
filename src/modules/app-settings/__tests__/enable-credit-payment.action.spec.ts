import type { DataSource, EntityManager } from 'typeorm';

import { GetEnableCreditPaymentAction } from '../actions/get-enable-credit-payment.action';
import { UpsertEnableCreditPaymentAction } from '../actions/upsert-enable-credit-payment.action';
import { APP_SETTING_KEYS } from '../entities/app-setting.entity';

/**
 * Tests de las actions del flag `enable_credit_payment` (visibilidad de la
 * tarjeta "Crédito" en el POS).
 *
 * Clave: el DEFAULT es TRUE. Si la fila no existe, el crédito viene VISIBLE
 * (comportamiento histórico) — los negocios ya registrados no necesitan backfill.
 */
describe('GetEnableCreditPaymentAction', () => {
  let findOneSpy: jest.Mock;
  let action: GetEnableCreditPaymentAction;

  beforeEach(() => {
    findOneSpy = jest.fn();
    const dataSourceMock = {
      getRepository: jest.fn().mockReturnValue({ findOne: findOneSpy }),
    } as unknown as DataSource;
    action = new GetEnableCreditPaymentAction(dataSourceMock);
  });

  it('default TRUE cuando la key NO existe (crédito visible)', async () => {
    findOneSpy.mockResolvedValue(null);
    await expect(action.execute(42)).resolves.toEqual({ enabled: true });
  });

  it("enabled=false SOLO con un 'false' explícito", async () => {
    findOneSpy.mockResolvedValue({ value: 'false' });
    await expect(action.execute(42)).resolves.toEqual({ enabled: false });
  });

  it("enabled=true cuando value = 'true'", async () => {
    findOneSpy.mockResolvedValue({ value: 'true' });
    await expect(action.execute(42)).resolves.toEqual({ enabled: true });
  });

  it('filtra por company_id + key enable_credit_payment', async () => {
    findOneSpy.mockResolvedValue(null);
    await action.execute(7);
    expect(findOneSpy).toHaveBeenCalledWith({
      where: { company_id: '7', key: APP_SETTING_KEYS.ENABLE_CREDIT_PAYMENT },
    });
  });
});

describe('UpsertEnableCreditPaymentAction', () => {
  let managerMock: { findOne: jest.Mock; update: jest.Mock; insert: jest.Mock };
  let action: UpsertEnableCreditPaymentAction;

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
    action = new UpsertEnableCreditPaymentAction(dataSourceMock);
  });

  it('INSERTA value="false" cuando enabled=false y la key no existe', async () => {
    managerMock.findOne.mockResolvedValue(null);
    await expect(action.execute({ enabled: false }, 42)).resolves.toEqual({ enabled: false });
    expect(managerMock.insert).toHaveBeenCalledWith(expect.anything(), {
      company_id: '42',
      key: APP_SETTING_KEYS.ENABLE_CREDIT_PAYMENT,
      value: 'false',
    });
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
