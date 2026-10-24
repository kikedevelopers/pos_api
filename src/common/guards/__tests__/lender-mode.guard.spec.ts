import { ForbiddenException, type ExecutionContext } from '@nestjs/common';

import { LenderModeGuard } from '../lender-mode.guard';

function buildContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function buildGuard(company: { id: string; pos_mode: string } | null) {
  const findOne = jest.fn().mockResolvedValue(company);
  const dataSource = { getRepository: jest.fn().mockReturnValue({ findOne }) };
  return { guard: new LenderModeGuard(dataSource as never), findOne };
}

const USER = { user_id: 1, company_id: 42, type: 'owner' };

describe('LenderModeGuard', () => {
  it('deja pasar a un prestamista', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'lender' });
    await expect(guard.canActivate(buildContext(USER))).resolves.toBe(true);
  });

  it.each(['retail', 'restaurant', 'bar'])('403 en modo %s', async (pos_mode) => {
    const { guard } = buildGuard({ id: '42', pos_mode });
    await expect(guard.canActivate(buildContext(USER))).rejects.toThrow(/prestamistas/);
  });

  it('403 si la company no existe', async () => {
    const { guard } = buildGuard(null);
    await expect(guard.canActivate(buildContext(USER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403 sin usuario o sin company en el token', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'lender' });
    await expect(guard.canActivate(buildContext(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      guard.canActivate(buildContext({ user_id: 1, company_id: null, type: 'superadmin' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('consulta la company del JWT', async () => {
    const { guard, findOne } = buildGuard({ id: '42', pos_mode: 'lender' });
    await guard.canActivate(buildContext(USER));
    expect(findOne).toHaveBeenCalledWith({ where: { id: '42' }, select: { id: true, pos_mode: true } });
  });
});
