import { NotFoundException } from '@nestjs/common';

import { UpdateActivationAction } from '../update-activation.action';

interface Scenario {
  owner?: {
    id: string;
    email: string;
    activated_at: Date | null;
  } | null;
}

function build({ owner = null }: Scenario = {}) {
  const findOne = jest.fn().mockResolvedValue(owner);
  const update = jest.fn().mockResolvedValue(undefined);
  const manager = { findOne, update };
  const dataSource = {
    transaction: <T>(_level: unknown, cb: (m: unknown) => Promise<T>) => cb(manager),
  };

  const action = new UpdateActivationAction(dataSource as never);
  return { action, findOne, update };
}

const PENDING_OWNER = {
  id: '7',
  email: 'kike@esenciaygrano.com',
  activated_at: null as Date | null,
};

describe('UpdateActivationAction', () => {
  it('activa una cuenta sin activar y sella la fecha', async () => {
    const { action, update } = build({ owner: { ...PENDING_OWNER } });

    const result = await action.execute(8, { active: true });

    expect(result.activated).toBe(true);
    expect(result.activatedAt).not.toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('desactiva una cuenta activa: limpia la fecha (bloquea el login)', async () => {
    const { action, update } = build({
      owner: { ...PENDING_OWNER, activated_at: new Date('2026-08-11T10:00:00.000Z') },
    });

    const result = await action.execute(8, { active: false });

    expect(result.activated).toBe(false);
    expect(result.activatedAt).toBeNull();
    expect(update).toHaveBeenCalledWith(expect.anything(), '7', { activated_at: null });
  });

  it('reactivar una cuenta ya activa NO reescribe la fecha original', async () => {
    const original = new Date('2026-08-11T10:00:00.000Z');
    const { action, update } = build({ owner: { ...PENDING_OWNER, activated_at: original } });

    const result = await action.execute(8, { active: true });

    expect(result.activatedAt).toBe(original.toISOString());
    // Ya estaba en el estado pedido: no hay UPDATE.
    expect(update).not.toHaveBeenCalled();
  });

  it('desactivar una cuenta ya sin activar es un no-op', async () => {
    const { action, update } = build({ owner: { ...PENDING_OWNER } });

    const result = await action.execute(8, { active: false });

    expect(result.activated).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('404 si la company no tiene owner', async () => {
    const { action, update } = build({ owner: null });

    await expect(action.execute(8, { active: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it('busca al OWNER de esa company, no a cualquier usuario', async () => {
    const { action, findOne } = build({ owner: { ...PENDING_OWNER } });

    await action.execute(8, { active: true });

    expect(findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: { company_id: '8', type: 'owner' } }),
    );
  });
});
