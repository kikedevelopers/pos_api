import { NotFoundException } from '@nestjs/common';

import { UpdateAiAccessAction } from '../update-ai-access.action';

// ---------------------------------------------------------------------------
// Interruptor de acceso al asistente Place (IA) por cuenta.
//
// A diferencia de la FE, el acceso a Place es por NEGOCIO (su company) y no se
// restringe al principal: cualquier company (principal o sucursal) puede
// togglearse. Apagado por defecto.
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
    action: new UpdateAiAccessAction(dataSource as never),
    save,
    findOne,
    dataSource,
  };
}

const COMPANY = { id: '8', name: 'Esencia & Grano', is_branch: false, ai_enabled: false };

describe('UpdateAiAccessAction', () => {
  it('404 si la company no existe (no persiste nada)', async () => {
    const { action, save } = build({ company: null });

    await expect(action.execute(999, { enabled: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(save).not.toHaveBeenCalled();
  });

  it('habilita el acceso a Place de la cuenta', async () => {
    const { action, save } = build({ company: { ...COMPANY } });

    const result = await action.execute(8, { enabled: true });

    expect(result).toEqual({ aiEnabled: true });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: '8', ai_enabled: true }));
  });

  it('deshabilita el acceso a Place de la cuenta', async () => {
    const { action, save } = build({ company: { ...COMPANY, ai_enabled: true } });

    const result = await action.execute(8, { enabled: false });

    expect(result).toEqual({ aiEnabled: false });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: '8', ai_enabled: false }));
  });

  it('también aplica sobre una sucursal (el acceso es por company, no por principal)', async () => {
    const { action, save } = build({
      company: { id: '12', name: 'Sucursal Sur', is_branch: true, ai_enabled: false },
    });

    const result = await action.execute(12, { enabled: true });

    expect(result).toEqual({ aiEnabled: true });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: '12', ai_enabled: true }));
  });

  it('persiste dentro de una transacción SERIALIZABLE', async () => {
    const { action, dataSource } = build({ company: { ...COMPANY } });

    await action.execute(8, { enabled: true });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(dataSource.transaction.mock.calls[0][0]).toBe('SERIALIZABLE');
  });
});
