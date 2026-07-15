jest.mock('argon2', () => ({ verify: jest.fn().mockResolvedValue(true) }));

import { LoginAction } from '../login.action';

function build(userOverrides: Record<string, unknown> = {}) {
  const user = {
    id: '1',
    company_id: '8',
    name: 'Cesar',
    lastname: 'Rojas',
    email: 'cesar@hotmail.com',
    password: 'argon-hash',
    type: 'owner',
    ...userOverrides,
  };
  const updateFn = jest.fn().mockResolvedValue(undefined);
  const usersService = { findByEmail: jest.fn().mockResolvedValue(user) };
  const employeesService = { findByUsername: jest.fn() };
  const jwtIssuer = { sign: jest.fn().mockResolvedValue('tok') };
  const dummyHash = {};
  const subscriptionsService = {
    findApplicable: jest
      .fn()
      .mockResolvedValue({ expires_at: new Date(Date.now() + 1_000_000_000) }),
  };
  const dataSource = { getRepository: jest.fn().mockReturnValue({ update: updateFn }) };

  const action = new LoginAction(
    usersService as never,
    employeesService as never,
    jwtIssuer as never,
    dummyHash as never,
    subscriptionsService as never,
    dataSource as never,
  );
  return { action, updateFn, user };
}

describe('LoginAction · last_login', () => {
  it('actualiza last_login del owner tras un login exitoso', async () => {
    const { action, updateFn, user } = build();

    const res = await action.execute({ username: 'cesar@hotmail.com', password: 'pw' });

    expect(updateFn).toHaveBeenCalledTimes(1);
    const [id, patch] = updateFn.mock.calls[0];
    expect(id).toBe(user.id);
    expect(patch.last_login).toBeInstanceOf(Date);
    expect(res.access_token).toBe('tok');
  });

  it('el superadmin (company_id null) también actualiza last_login (exento de suscripción)', async () => {
    const { action, updateFn } = build({ company_id: null, type: 'superadmin' });

    await action.execute({ username: 'cesar@hotmail.com', password: 'pw' });

    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateFn.mock.calls[0][1].last_login).toBeInstanceOf(Date);
  });
});
