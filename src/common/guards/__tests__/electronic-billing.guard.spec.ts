import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { ElectronicBillingGuard } from '../electronic-billing.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardWith(enabled: boolean) {
  const dataSource = {
    query: jest.fn().mockResolvedValue([{ electronic_billing_enabled: enabled }]),
  };
  return new ElectronicBillingGuard(dataSource as never);
}

describe('ElectronicBillingGuard', () => {
  it('deja pasar cuando la FE está activa', async () => {
    const guard = guardWith(true);
    await expect(guard.canActivate(contextWithUser({ company_id: 8 }))).resolves.toBe(true);
  });

  it('403 cuando la FE está apagada (estado actual de la BD)', async () => {
    const guard = guardWith(false);
    await expect(guard.canActivate(contextWithUser({ company_id: 8 }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('403 cuando el usuario no tiene company', async () => {
    const guard = guardWith(true);
    await expect(guard.canActivate(contextWithUser({ company_id: null }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(guard.canActivate(contextWithUser(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
