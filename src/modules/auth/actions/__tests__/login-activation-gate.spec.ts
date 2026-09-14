jest.mock('argon2', () => ({ verify: jest.fn() }));

import { ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';

import { LoginAction } from '../login.action';

const verifyMock = argon2.verify as unknown as jest.Mock;

/** Login con un owner cuyo estado de activación se controla desde el test. */
function build(activatedAt: Date | null) {
  const user = {
    id: '1',
    company_id: '8',
    name: 'Enrique',
    lastname: 'Pacheco',
    email: 'kike@esenciaygrano.com',
    password: 'argon-hash',
    type: 'owner',
    activated_at: activatedAt,
  };
  const usersService = { findByEmail: jest.fn().mockResolvedValue(user) };
  const employeesService = { findByUsername: jest.fn().mockResolvedValue(null) };
  const jwtIssuer = { sign: jest.fn().mockResolvedValue('tok') };
  const subscriptionsService = {
    findApplicable: jest
      .fn()
      .mockResolvedValue({ expires_at: new Date(Date.now() + 1_000_000_000) }),
  };
  const dataSource = {
    getRepository: jest.fn().mockReturnValue({ update: jest.fn().mockResolvedValue(undefined) }),
  };

  const action = new LoginAction(
    usersService as never,
    employeesService as never,
    jwtIssuer as never,
    {} as never,
    subscriptionsService as never,
    dataSource as never,
  );
  return { action, jwtIssuer, subscriptionsService };
}

const credentials = { username: 'kike@esenciaygrano.com', password: 'pw' };

describe('LoginAction · cuenta sin activar', () => {
  beforeEach(() => {
    verifyMock.mockReset();
    verifyMock.mockResolvedValue(true);
  });

  it('rechaza el login de una cuenta sin activar', async () => {
    const { action, jwtIssuer } = build(null);

    const error = await action.execute(credentials).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    // Nunca se firma un JWT: sin activar no hay sesión, ni siquiera efímera.
    expect(jwtIssuer.sign).not.toHaveBeenCalled();
  });

  it('el error trae el código que el cliente usa para explicar qué hacer', async () => {
    const { action } = build(null);

    const error = (await action
      .execute(credentials)
      .catch((e: unknown) => e)) as ForbiddenException;
    const body = error.getResponse() as { message: string; payload: { code: string } };

    expect(body.payload.code).toBe('ACCOUNT_NOT_ACTIVATED');
    expect(body.message).toContain('Activar mi cuenta');
  });

  it('deja pasar la cuenta activada', async () => {
    const { action, jwtIssuer } = build(new Date('2026-08-12T10:00:00.000Z'));

    const result = await action.execute(credentials);

    expect(result.access_token).toBe('tok');
    expect(jwtIssuer.sign).toHaveBeenCalledTimes(1);
  });

  it('el bloqueo corre DESPUÉS de verificar la contraseña', async () => {
    // Anti-enumeración: si el chequeo fuera antes, un atacante sabría que un
    // correo existe (y que está sin activar) sin conocer la contraseña.
    verifyMock.mockResolvedValue(false);
    const { action } = build(null);

    await expect(action.execute(credentials)).rejects.toMatchObject({ status: 401 });
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it('el bloqueo corre ANTES de mirar la suscripción', async () => {
    // A quien no ha confirmado su correo no tiene sentido hablarle de la
    // vigencia de su plan: el mensaje accionable es el de la activación.
    const { action, subscriptionsService } = build(null);

    await expect(action.execute(credentials)).rejects.toBeInstanceOf(ForbiddenException);
    expect(subscriptionsService.findApplicable).not.toHaveBeenCalled();
  });

  it('una cuenta sin la columna poblada NO entra (fail-closed)', async () => {
    // Un SELECT que no traiga `activated_at` no puede convertirse en un
    // bypass silencioso de la medida de seguridad.
    const { action } = build(undefined as unknown as Date);

    await expect(action.execute(credentials)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
