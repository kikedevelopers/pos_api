jest.mock('argon2', () => ({ verify: jest.fn().mockResolvedValue(true) }));
jest.mock('@/modules/employees/internal/ensure-mirror-user-for-employee.helper', () => ({
  ensureMirrorUserForEmployee: jest.fn().mockResolvedValue({ id: 'mirror-1' }),
}));

import * as argon2 from 'argon2';

import { LoginAction } from '../login.action';

function build(employeeOverrides: Record<string, unknown> = {}) {
  const employee = {
    id: '5',
    company_id: '8',
    name: 'Panchito',
    username: 'panchito',
    password: 'argon-hash',
    role: 'employee',
    login_enabled: true,
    is_archived: false,
    ...employeeOverrides,
  };
  const updateFn = jest.fn().mockResolvedValue(undefined);
  // username 'panchito' NO luce email → el path User se salta y cae al de employee.
  const usersService = { findByEmail: jest.fn().mockResolvedValue(null) };
  const employeesService = { findByUsername: jest.fn().mockResolvedValue(employee) };
  const jwtIssuer = { sign: jest.fn().mockResolvedValue('tok') };
  const dummyHash = { verify: jest.fn().mockResolvedValue(undefined) };
  const subscriptionsService = {
    findApplicable: jest
      .fn()
      .mockResolvedValue({ expires_at: new Date(Date.now() + 1_000_000_000) }),
  };
  const dataSource = {
    getRepository: jest.fn().mockReturnValue({ update: updateFn }),
    // La transacción del espejo simplemente invoca el callback.
    transaction: jest.fn((cb: (m: unknown) => unknown) => cb({})),
  };

  const action = new LoginAction(
    usersService as never,
    employeesService as never,
    jwtIssuer as never,
    dummyHash as never,
    subscriptionsService as never,
    dataSource as never,
  );
  return { action, updateFn, employee };
}

describe('LoginAction · last_login del empleado', () => {
  beforeEach(() => {
    (argon2.verify as jest.Mock).mockResolvedValue(true);
  });

  it('sella employees.last_login tras un login de empleado exitoso', async () => {
    const { action, updateFn, employee } = build();

    const res = await action.execute({ username: 'panchito', password: 'pw' } as never);

    expect(updateFn).toHaveBeenCalledTimes(1);
    const [id, patch] = updateFn.mock.calls[0];
    expect(id).toBe(employee.id);
    expect(patch.last_login).toBeInstanceOf(Date);
    expect(res.access_token).toBe('tok');
  });

  it('NO sella last_login cuando la contraseña es inválida', async () => {
    const { action, updateFn } = build();
    (argon2.verify as jest.Mock).mockResolvedValueOnce(false);

    await expect(
      action.execute({ username: 'panchito', password: 'mala' } as never),
    ).rejects.toThrow();

    expect(updateFn).not.toHaveBeenCalled();
  });
});
