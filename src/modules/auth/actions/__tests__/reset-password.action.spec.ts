jest.mock('argon2', () => ({ hash: jest.fn().mockResolvedValue('argon-hash-nuevo') }));

import { BadRequestException } from '@nestjs/common';
import * as argon2 from 'argon2';

import { ResetPasswordAction } from '../reset-password.action';
import { hashPasswordResetToken } from '../../internal/password-reset-token';

const TOKEN = 'b'.repeat(64);
const VALID_PASSWORD = 'Password1!';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 1000);

interface Scenario {
  token?: { id: string; user_id: string; expires_at: Date; used_at: Date | null } | null;
  user?: { id: string; email: string } | null;
}

function build({ token = null, user = null }: Scenario = {}) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const seenHashes: string[] = [];

  const manager = {
    createQueryBuilder: () => ({
      setLock: () => ({
        where: (_sql: string, params: { tokenHash: string }) => {
          seenHashes.push(params.tokenHash);
          return { getOne: () => Promise.resolve(token) };
        },
      }),
    }),
    findOne: jest.fn().mockResolvedValue(user),
    update: jest.fn((_entity: unknown, id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      return Promise.resolve(undefined);
    }),
  };

  const dataSource = { transaction: <T>(cb: (m: unknown) => Promise<T>) => cb(manager) };
  const sendPasswordChangedEmailAction = { execute: jest.fn().mockResolvedValue(true) };

  const action = new ResetPasswordAction(
    dataSource as never,
    sendPasswordChangedEmailAction as never,
  );
  return { action, updates, seenHashes, sendPasswordChangedEmailAction, manager };
}

const OK = {
  token: { id: '1', user_id: '7', expires_at: FUTURE, used_at: null },
  user: { id: '7', email: 'kike@esenciaygrano.com' },
};

describe('ResetPasswordAction', () => {
  it('cambia la contraseña y quema el token', async () => {
    const { action, updates } = build(OK);

    const result = await action.execute(TOKEN, VALID_PASSWORD);

    expect(result).toEqual({ updated: true, email: 'k***e@esenciaygrano.com' });
    expect(updates).toHaveLength(2);
    expect(updates[0].patch.used_at).toBeInstanceOf(Date);
    expect(updates[1].patch.password).toBe('argon-hash-nuevo');
  });

  it('guarda el HASH de la contraseña, nunca el texto plano', async () => {
    const { action, updates } = build(OK);

    await action.execute(TOKEN, VALID_PASSWORD);

    expect(argon2.hash).toHaveBeenCalledWith(VALID_PASSWORD, expect.anything());
    expect(JSON.stringify(updates)).not.toContain(VALID_PASSWORD);
  });

  it('busca el token por su hash, no por el valor en claro', async () => {
    const { action, seenHashes } = build(OK);

    await action.execute(TOKEN, VALID_PASSWORD);

    expect(seenHashes).toEqual([hashPasswordResetToken(TOKEN)]);
    expect(seenHashes[0]).not.toBe(TOKEN);
  });

  it('avisa por correo del cambio', async () => {
    // Es la única señal que recibe alguien a quien le robaron el acceso.
    const { action, sendPasswordChangedEmailAction } = build(OK);

    await action.execute(TOKEN, VALID_PASSWORD);

    expect(sendPasswordChangedEmailAction.execute).toHaveBeenCalledWith({
      customer_email: 'kike@esenciaygrano.com',
    });
  });

  it('rechaza una contraseña que no cumple las reglas, ANTES de tocar la base', async () => {
    const { action, manager } = build(OK);

    for (const weak of ['corta1!', 'sinmayuscula1!', 'SINMINUSCULA1!', 'SinEspecial12']) {
      await expect(action.execute(TOKEN, weak)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(manager.findOne).not.toHaveBeenCalled();
  });

  it('el error de contraseña dice QUÉ falta', async () => {
    const { action } = build(OK);

    const error = (await action
      .execute(TOKEN, 'password')
      .catch((e: unknown) => e)) as BadRequestException;
    const body = error.getResponse() as { message: string; payload: { code: string } };

    expect(body.payload.code).toBe('PASSWORD_POLICY');
    expect(body.message).toContain('mayúscula');
  });

  it('rechaza un token con forma inválida sin tocar la base', async () => {
    const { action, manager } = build(OK);

    for (const bad of ['', 'corto', 'z'.repeat(64)]) {
      await expect(action.execute(bad, VALID_PASSWORD)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(manager.findOne).not.toHaveBeenCalled();
  });

  it('distingue el token vencido del ya usado', async () => {
    const vencido = build({ ...OK, token: { ...OK.token, expires_at: PAST } });
    const usado = build({ ...OK, token: { ...OK.token, used_at: new Date() } });

    const e1 = (await vencido.action
      .execute(TOKEN, VALID_PASSWORD)
      .catch((e: unknown) => e)) as BadRequestException;
    const e2 = (await usado.action
      .execute(TOKEN, VALID_PASSWORD)
      .catch((e: unknown) => e)) as BadRequestException;

    expect((e1.getResponse() as { payload: { code: string } }).payload.code).toBe(
      'RESET_TOKEN_EXPIRED',
    );
    expect((e2.getResponse() as { payload: { code: string } }).payload.code).toBe(
      'RESET_TOKEN_USED',
    );
  });

  it('un token inexistente no cambia nada', async () => {
    const { action, updates } = build({ token: null });

    await expect(action.execute(TOKEN, VALID_PASSWORD)).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it('un token cuyo usuario desapareció no cambia nada', async () => {
    const { action, updates } = build({ token: OK.token, user: null });

    await expect(action.execute(TOKEN, VALID_PASSWORD)).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it('devuelve el correo enmascarado', async () => {
    // La respuesta viaja a una pantalla que puede estar a la vista de otros.
    const { action } = build(OK);
    const result = await action.execute(TOKEN, VALID_PASSWORD);
    expect(result.email).not.toContain('kike@');
  });
});
