import { ForbiddenException, type ExecutionContext } from '@nestjs/common';

import { LenderModeGuard } from './lender-mode.guard';

const buildContext = (user: unknown): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

const buildGuard = (isLender: boolean) => {
  const tenant = { isLender: jest.fn().mockResolvedValue(isLender) };
  return { guard: new LenderModeGuard(tenant), tenant };
};

const USER = { user_id: 1, company_id: 42, type: 'owner' };

describe('LenderModeGuard', () => {
  it('deja pasar a un prestamista y consulta la company del JWT', async () => {
    const { guard, tenant } = buildGuard(true);
    await expect(guard.canActivate(buildContext(USER))).resolves.toBe(true);
    expect(tenant.isLender).toHaveBeenCalledWith(42);
  });

  it('403 si la company no es prestamista', async () => {
    const { guard } = buildGuard(false);
    await expect(guard.canActivate(buildContext(USER))).rejects.toThrow(/prestamistas/);
  });

  it('403 sin usuario o sin company en el token, sin consultar el tenant', async () => {
    const { guard, tenant } = buildGuard(true);
    await expect(guard.canActivate(buildContext(undefined))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guard.canActivate(buildContext({ user_id: 1, company_id: null, type: 'superadmin' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tenant.isLender).not.toHaveBeenCalled();
  });
});
