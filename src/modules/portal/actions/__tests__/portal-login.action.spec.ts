jest.mock('argon2', () => ({ verify: jest.fn() }));

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';

import { PortalLoginAction } from '../portal-login.action';

const verifyMock = argon2.verify as unknown as jest.Mock;

// ---------------------------------------------------------------------------
// El login del portal de facturación.
//
// Se separa del login de la app por una razón concreta: aquí SÍ entra quien
// tiene la suscripción vencida, porque es quien necesita pagar. Ese permiso
// extra obliga a que todo lo demás sea igual de estricto —cuenta activada,
// solo dueños— y a que el token que sale esté acotado.
// ---------------------------------------------------------------------------

interface UserSeed {
  type?: string;
  activated_at?: Date | null;
  company_id?: string | null;
}

function build(seed: UserSeed | null) {
  const user =
    seed === null
      ? null
      : {
          id: '1',
          company_id: seed.company_id === undefined ? '8' : seed.company_id,
          name: 'Enrique',
          lastname: 'Pacheco',
          email: 'kike@esenciaygrano.com',
          password: 'argon-hash',
          type: seed.type ?? 'owner',
          activated_at:
            seed.activated_at === undefined ? new Date('2026-01-01') : seed.activated_at,
        };

  const usersService = { findByEmail: jest.fn().mockResolvedValue(user) };
  const jwtIssuer = { sign: jest.fn().mockResolvedValue('tok') };
  const dummyHash = { get: jest.fn().mockReturnValue('dummy-hash') };

  const action = new PortalLoginAction(
    usersService as never,
    jwtIssuer as never,
    dummyHash as never,
  );

  return { action, jwtIssuer, dummyHash, usersService };
}

const credentials = { email: 'kike@esenciaygrano.com', password: 'pw' };

beforeEach(() => {
  verifyMock.mockReset();
  verifyMock.mockResolvedValue(true);
});

describe('camino feliz', () => {
  it('el dueño entra y recibe un token acotado al portal', async () => {
    const { action, jwtIssuer } = build({});

    const result = await action.execute(credentials);

    expect(result.access_token).toBe('tok');
    expect(result.user.email).toBe('kike@esenciaygrano.com');
    expect(jwtIssuer.sign).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'portal', type: 'owner', account: 'user' }),
    );
  });

  it('entra aunque la suscripción esté vencida', async () => {
    // La prueba real es estructural: esta action NO conoce el servicio de
    // suscripciones, así que no hay forma de que un vencimiento la bloquee.
    // Si alguien le inyecta ese chequeo, este constructor deja de compilar.
    expect(PortalLoginAction.length).toBe(3);

    const { action } = build({});
    await expect(action.execute(credentials)).resolves.toHaveProperty('access_token');
  });
});

describe('credenciales', () => {
  it('rechaza con contraseña incorrecta', async () => {
    verifyMock.mockResolvedValue(false);
    const { action, jwtIssuer } = build({});

    await expect(action.execute(credentials)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwtIssuer.sign).not.toHaveBeenCalled();
  });

  it('con un correo que no existe responde lo mismo y gasta el verify dummy', async () => {
    const { action, dummyHash } = build(null);

    const error = await action.execute(credentials).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnauthorizedException);
    // Sin este verify, el tiempo de respuesta delataría qué correos existen.
    expect(dummyHash.get).toHaveBeenCalled();
    expect(verifyMock).toHaveBeenCalledWith('dummy-hash', 'pw');
  });

  it('el usuario espejo de un empleado no entra por correo', async () => {
    const { action, jwtIssuer } = build({ type: 'employee' });

    await expect(action.execute(credentials)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwtIssuer.sign).not.toHaveBeenCalled();
  });
});

describe('quién puede entrar', () => {
  it('la cuenta sin activar se rechaza con el mismo código que en la app', async () => {
    const { action, jwtIssuer } = build({ activated_at: null });

    const error = (await action
      .execute(credentials)
      .catch((e: unknown) => e)) as ForbiddenException;
    const body = error.getResponse() as { payload: { code: string } };

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(body.payload.code).toBe('ACCOUNT_NOT_ACTIVATED');
    expect(jwtIssuer.sign).not.toHaveBeenCalled();
  });

  it('sin activar manda antes que cualquier otra cosa', async () => {
    // Un empleado sin activar debe oír "activa tu cuenta", no "no eres el
    // dueño": lo primero tiene solución, lo segundo lo deja sin saber qué hacer.
    const { action } = build({ type: 'manager', activated_at: null });

    const error = (await action
      .execute(credentials)
      .catch((e: unknown) => e)) as ForbiddenException;
    const body = error.getResponse() as { payload: { code: string } };

    expect(body.payload.code).toBe('ACCOUNT_NOT_ACTIVATED');
  });

  it('quien no es dueño recibe un mensaje que le dice a dónde ir', async () => {
    const { action, jwtIssuer } = build({ type: 'manager' });

    const error = (await action
      .execute(credentials)
      .catch((e: unknown) => e)) as ForbiddenException;
    const body = error.getResponse() as { message: string; payload: { code: string } };

    expect(body.payload.code).toBe('PORTAL_OWNER_ONLY');
    expect(body.message).toMatch(/aplicación/i);
    expect(jwtIssuer.sign).not.toHaveBeenCalled();
  });

  it('el superadmin tampoco entra: no tiene negocio ni plan que gestionar', async () => {
    const { action, jwtIssuer } = build({ type: 'superadmin', company_id: null });

    const error = (await action
      .execute(credentials)
      .catch((e: unknown) => e)) as ForbiddenException;
    const body = error.getResponse() as { payload: { code: string } };

    expect(body.payload.code).toBe('PORTAL_OWNER_ONLY');
    expect(jwtIssuer.sign).not.toHaveBeenCalled();
  });

  it('un dueño sin company es un dato roto: no se firma nada', async () => {
    const { action, jwtIssuer } = build({ type: 'owner', company_id: null });

    await expect(action.execute(credentials)).rejects.toBeInstanceOf(ForbiddenException);
    expect(jwtIssuer.sign).not.toHaveBeenCalled();
  });
});
