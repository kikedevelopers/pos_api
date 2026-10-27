import { ForbiddenException, type ExecutionContext } from '@nestjs/common';

import { RetailModeGuard } from '../retail-mode.guard';

interface CompanyRow {
  id: string;
  pos_mode: string;
}

function buildContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function buildGuard(company: CompanyRow | null) {
  const findOne = jest.fn().mockResolvedValue(company);
  const dataSource = { getRepository: jest.fn().mockReturnValue({ findOne }) };
  return { guard: new RetailModeGuard(dataSource as never), findOne };
}

const USER = { user_id: 1, company_id: 42, type: 'owner' };

describe('RetailModeGuard', () => {
  it('deja pasar en modo retail', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'retail' });
    await expect(guard.canActivate(buildContext(USER))).resolves.toBe(true);
  });

  it('403 en modo restaurante, remitiendo a Comandas', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'restaurant' });
    await expect(guard.canActivate(buildContext(USER))).rejects.toThrow(/Comandas/);
  });

  it('403 para prestamistas (no tienen punto de venta)', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'lender' });
    await expect(guard.canActivate(buildContext(USER))).rejects.toThrow(/prestamistas/);
  });

  it('un pos_mode desconocido se trata como retail (pasa)', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'bar' });
    await expect(guard.canActivate(buildContext(USER))).resolves.toBe(true);
  });

  it('company inexistente se trata como retail (pasa)', async () => {
    const { guard } = buildGuard(null);
    await expect(guard.canActivate(buildContext(USER))).resolves.toBe(true);
  });

  it('403 sin usuario o sin company en el token', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'retail' });
    await expect(guard.canActivate(buildContext(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      guard.canActivate(buildContext({ user_id: 1, company_id: null, type: 'superadmin' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
