import { ForbiddenException } from '@nestjs/common';

import {
  ELECTRONIC_BILLING_DISABLED,
  assertElectronicBillingEnabled,
  isElectronicBillingEnabled,
} from '../electronic-billing.util';

// El chequeo lee el estado ACTUAL de la BD (no del JWT): si el superadmin apagó
// la FE hace segundos, aquí ya sale false aunque el front siga creyendo que es
// facturador.
function db(enabled: boolean | undefined) {
  return {
    query: jest.fn().mockResolvedValue(
      enabled === undefined ? [] : [{ electronic_billing_enabled: enabled }],
    ),
  };
}

describe('isElectronicBillingEnabled', () => {
  it('true cuando la company la tiene activa', async () => {
    await expect(isElectronicBillingEnabled(db(true), 8)).resolves.toBe(true);
  });

  it('false cuando está apagada', async () => {
    await expect(isElectronicBillingEnabled(db(false), 8)).resolves.toBe(false);
  });

  it('false cuando la company no existe (fila vacía)', async () => {
    await expect(isElectronicBillingEnabled(db(undefined), 999)).resolves.toBe(false);
  });

  it('filtra por company_id como string (bigint de pg)', async () => {
    const q = db(true);
    await isElectronicBillingEnabled(q, 8);
    expect(q.query.mock.calls[0][1]).toEqual(['8']);
  });
});

describe('assertElectronicBillingEnabled', () => {
  it('pasa cuando está activa', async () => {
    await expect(assertElectronicBillingEnabled(db(true), 8)).resolves.toBeUndefined();
  });

  it('403 con código estable cuando está apagada', async () => {
    await expect(assertElectronicBillingEnabled(db(false), 8)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    try {
      await assertElectronicBillingEnabled(db(false), 8);
    } catch (e) {
      expect((e as ForbiddenException).getResponse()).toMatchObject({
        code: ELECTRONIC_BILLING_DISABLED,
      });
    }
  });
});
