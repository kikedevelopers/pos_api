import { BadRequestException, NotFoundException } from '@nestjs/common';

import { UpdateElectronicBillingAction } from '../update-electronic-billing.action';

// ---------------------------------------------------------------------------
// Interruptor de Facturación Electrónica por negocio.
//
// La FE es identidad fiscal del NEGOCIO PRINCIPAL (NIT, resolución): una
// sucursal la hereda, no la administra. El proceso de FE en sí corre en el API
// externo (APIDIAN); esta action solo persiste el flag de habilitación.
// ---------------------------------------------------------------------------

interface Options {
  company: Record<string, unknown> | null;
}

function build(opts: Options) {
  const save = jest.fn((c: Record<string, unknown>) => Promise.resolve(c));
  const findOne = jest.fn().mockResolvedValue(opts.company);
  const manager = {
    getRepository: () => ({ findOne, save }),
  };
  const dataSource = {
    transaction: jest.fn((_level: string, cb: (m: unknown) => Promise<unknown>) => cb(manager)),
  };
  return {
    action: new UpdateElectronicBillingAction(dataSource as never),
    save,
    findOne,
    dataSource,
  };
}

const PRINCIPAL = { id: '8', name: 'Esencia & Grano', is_branch: false, electronic_billing_enabled: false };
const SUCURSAL = { id: '12', name: 'Esencia & Grano Sur', is_branch: true, electronic_billing_enabled: false };

describe('UpdateElectronicBillingAction', () => {
  it('404 si la company no existe (no persiste nada)', async () => {
    const { action, save } = build({ company: null });

    await expect(action.execute(999, { enabled: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(save).not.toHaveBeenCalled();
  });

  it('400 si el objetivo es una SUCURSAL (la FE se configura en el principal)', async () => {
    const { action, save } = build({ company: { ...SUCURSAL } });

    await expect(action.execute(12, { enabled: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('activa la FE del negocio principal', async () => {
    const { action, save } = build({ company: { ...PRINCIPAL } });

    const result = await action.execute(8, { enabled: true });

    expect(result).toEqual({ electronicBillingEnabled: true });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '8', electronic_billing_enabled: true }),
    );
  });

  it('desactiva la FE del negocio principal', async () => {
    const { action, save } = build({
      company: { ...PRINCIPAL, electronic_billing_enabled: true },
    });

    const result = await action.execute(8, { enabled: false });

    expect(result).toEqual({ electronicBillingEnabled: false });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '8', electronic_billing_enabled: false }),
    );
  });

  it('persiste dentro de una transacción SERIALIZABLE', async () => {
    const { action, dataSource } = build({ company: { ...PRINCIPAL } });

    await action.execute(8, { enabled: true });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(dataSource.transaction.mock.calls[0][0]).toBe('SERIALIZABLE');
  });
});
