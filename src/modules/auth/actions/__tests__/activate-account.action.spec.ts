import { BadRequestException } from '@nestjs/common';

import { ActivateAccountAction } from '../activate-account.action';
import { hashActivationToken } from '../../internal/activation-token';

const TOKEN = 'a'.repeat(64);
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 1000);

interface Scenario {
  /** Fila de `user_activation_tokens`, o null si el token no existe. */
  token?: { id: string; user_id: string; expires_at: Date; used_at: Date | null } | null;
  /** Fila de `users` a la que apunta el token. */
  user?: {
    id: string;
    name: string;
    email: string;
    company_id: string | null;
    activated_at: Date | null;
  } | null;
}

/**
 * Monta la action con un DataSource falso. `transaction(cb)` ejecuta el callback
 * con un manager de mentira, que es donde vive toda la lógica interesante.
 */
function build({ token = null, user = null }: Scenario = {}) {
  const updates: Array<{ entity: string; id: string; patch: Record<string, unknown> }> = [];

  const manager = {
    createQueryBuilder: () => ({
      setLock: () => ({
        where: () => ({ getOne: () => Promise.resolve(token) }),
      }),
    }),
    findOne: jest.fn().mockResolvedValue(user),
    update: jest.fn((entity: { name: string }, id: string, patch: Record<string, unknown>) => {
      updates.push({ entity: entity.name, id, patch });
      return Promise.resolve(undefined);
    }),
  };

  const companyRepo = { findOne: jest.fn().mockResolvedValue({ name: 'Esencia & Grano' }) };
  const dataSource = {
    transaction: <T>(cb: (m: unknown) => Promise<T>) => cb(manager),
    getRepository: jest.fn().mockReturnValue(companyRepo),
  };
  const sendAccountActivatedEmailAction = { execute: jest.fn().mockResolvedValue(true) };

  const action = new ActivateAccountAction(
    dataSource as never,
    sendAccountActivatedEmailAction as never,
  );
  return { action, updates, sendAccountActivatedEmailAction, manager };
}

const ACTIVE_USER = {
  id: '7',
  name: 'Enrique',
  email: 'kike@esenciaygrano.com',
  company_id: '8',
  activated_at: null as Date | null,
};

describe('ActivateAccountAction', () => {
  it('activa la cuenta y quema el token', async () => {
    const { action, updates } = build({
      token: { id: '1', user_id: '7', expires_at: FUTURE, used_at: null },
      user: { ...ACTIVE_USER },
    });

    const result = await action.execute(TOKEN);

    expect(result).toMatchObject({
      activated: true,
      already_activated: false,
      name: 'Enrique',
      email: 'kike@esenciaygrano.com',
    });
    // Dos escrituras: marcar el token como usado y sellar la activación.
    expect(updates).toHaveLength(2);
    expect(updates[0].patch.used_at).toBeInstanceOf(Date);
    expect(updates[1].patch.activated_at).toBeInstanceOf(Date);
  });

  it('avisa por correo de la activación', async () => {
    const { action, sendAccountActivatedEmailAction } = build({
      token: { id: '1', user_id: '7', expires_at: FUTURE, used_at: null },
      user: { ...ACTIVE_USER },
    });

    await action.execute(TOKEN);

    expect(sendAccountActivatedEmailAction.execute).toHaveBeenCalledWith({
      customer_name: 'Enrique',
      customer_email: 'kike@esenciaygrano.com',
      company_name: 'Esencia & Grano',
    });
  });

  it('rechaza un token con forma inválida sin tocar la base', async () => {
    const { action, manager } = build();

    for (const bad of ['', 'no-es-un-token', 'a'.repeat(63), 'z'.repeat(64)]) {
      await expect(action.execute(bad)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(manager.findOne).not.toHaveBeenCalled();
  });

  it('rechaza un token que no existe', async () => {
    const { action } = build({ token: null });

    const error = (await action.execute(TOKEN).catch((e: unknown) => e)) as BadRequestException;
    const body = error.getResponse() as { payload: { code: string } };

    expect(body.payload.code).toBe('ACTIVATION_TOKEN_INVALID');
  });

  it('rechaza un token vencido con su propio código', async () => {
    const { action } = build({
      token: { id: '1', user_id: '7', expires_at: PAST, used_at: null },
      user: { ...ACTIVE_USER },
    });

    const error = (await action.execute(TOKEN).catch((e: unknown) => e)) as BadRequestException;
    const body = error.getResponse() as { message: string; payload: { code: string } };

    expect(body.payload.code).toBe('ACTIVATION_TOKEN_EXPIRED');
    expect(body.message).toContain('venció');
  });

  it('un segundo clic sobre una cuenta YA activa responde ok, no error', async () => {
    // Es el caso más común del mundo real: el usuario pulsa el botón dos veces
    // o abre el correo en otro dispositivo. Mostrarle un error rojo por eso
    // sería mentirle: su cuenta está lista.
    const { action, updates, sendAccountActivatedEmailAction } = build({
      token: { id: '1', user_id: '7', expires_at: FUTURE, used_at: new Date() },
      user: { ...ACTIVE_USER, activated_at: new Date('2026-08-12T10:00:00.000Z') },
    });

    const result = await action.execute(TOKEN);

    expect(result).toMatchObject({ activated: true, already_activated: true });
    // No re-escribe nada ni reenvía el correo: sería ruido.
    expect(updates).toHaveLength(0);
    expect(sendAccountActivatedEmailAction.execute).not.toHaveBeenCalled();
  });

  it('un token ya usado cuya cuenta NO está activa sí es un error', async () => {
    // No es el doble clic: alguien reemitió el token y este quedó invalidado.
    const { action } = build({
      token: { id: '1', user_id: '7', expires_at: FUTURE, used_at: new Date() },
      user: { ...ACTIVE_USER, activated_at: null },
    });

    const error = (await action.execute(TOKEN).catch((e: unknown) => e)) as BadRequestException;
    const body = error.getResponse() as { payload: { code: string } };

    expect(body.payload.code).toBe('ACTIVATION_TOKEN_USED');
  });

  it('un token cuyo usuario desapareció no activa nada', async () => {
    const { action } = build({
      token: { id: '1', user_id: '7', expires_at: FUTURE, used_at: null },
      user: null,
    });

    await expect(action.execute(TOKEN)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('busca el token por su HASH, nunca por el valor en claro', async () => {
    // Si la consulta usara el token tal cual, la base guardaría credenciales
    // utilizables por cualquiera que la lea.
    const seen: string[] = [];
    const manager = {
      createQueryBuilder: () => ({
        setLock: () => ({
          where: (_sql: string, params: { tokenHash: string }) => {
            seen.push(params.tokenHash);
            return { getOne: () => Promise.resolve(null) };
          },
        }),
      }),
      findOne: jest.fn(),
      update: jest.fn(),
    };
    const dataSource = {
      transaction: <T>(cb: (m: unknown) => Promise<T>) => cb(manager),
      getRepository: jest.fn(),
    };
    const action = new ActivateAccountAction(dataSource as never, { execute: jest.fn() } as never);

    await action.execute(TOKEN).catch(() => undefined);

    expect(seen).toEqual([hashActivationToken(TOKEN)]);
    expect(seen[0]).not.toBe(TOKEN);
  });

  it('acepta el token con espacios de sobra alrededor', async () => {
    const { action } = build({
      token: { id: '1', user_id: '7', expires_at: FUTURE, used_at: null },
      user: { ...ACTIVE_USER },
    });

    await expect(action.execute(`  ${TOKEN}  `)).resolves.toMatchObject({ activated: true });
  });
});
