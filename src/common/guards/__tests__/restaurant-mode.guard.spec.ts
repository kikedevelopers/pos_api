import { ForbiddenException, type ExecutionContext } from '@nestjs/common';

import { RestaurantModeGuard } from '../restaurant-mode.guard';

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
  return { guard: new RestaurantModeGuard(dataSource as never), findOne };
}

const USER = { user_id: 1, company_id: 42, type: 'owner' };

describe('RestaurantModeGuard', () => {
  it('deja pasar si la company está en modo restaurante', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'restaurant' });
    await expect(guard.canActivate(buildContext(USER))).resolves.toBe(true);
  });

  it('403 si la company está en modo retail', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'retail' });
    await expect(guard.canActivate(buildContext(USER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403 ante un pos_mode desconocido (se normaliza a retail)', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'bar' });
    await expect(guard.canActivate(buildContext(USER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403 si la company no existe', async () => {
    const { guard } = buildGuard(null);
    await expect(guard.canActivate(buildContext(USER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403 sin usuario en la request', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'restaurant' });
    await expect(guard.canActivate(buildContext(undefined))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403 para superadmin (company_id null)', async () => {
    const { guard } = buildGuard({ id: '42', pos_mode: 'restaurant' });
    await expect(
      guard.canActivate(buildContext({ user_id: 1, company_id: null, type: 'superadmin' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('consulta la company por el company_id del JWT', async () => {
    const { guard, findOne } = buildGuard({ id: '42', pos_mode: 'restaurant' });
    await guard.canActivate(buildContext(USER));
    expect(findOne).toHaveBeenCalledWith({
      where: { id: '42' },
      select: { id: true, pos_mode: true },
    });
  });
});
