import type { BadRequestException } from '@nestjs/common';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { RequestPasswordResetAction } from '../request-password-reset.action';

interface Scenario {
  user?: { id: string; name: string; email: string; activated_at: Date | null } | null;
  emailSent?: boolean;
}

function build({ user = null, emailSent = true }: Scenario = {}) {
  const findOne = jest.fn().mockResolvedValue(user);
  const saved: Array<Record<string, unknown>> = [];
  const invalidated: string[] = [];

  const manager = {
    createQueryBuilder: () => ({
      update: () => ({
        set: () => ({
          where: (_sql: string, params: { userId: string }) => {
            invalidated.push(params.userId);
            return { execute: () => Promise.resolve(undefined) };
          },
        }),
      }),
    }),
    create: (_entity: unknown, data: Record<string, unknown>) => data,
    save: jest.fn((data: Record<string, unknown>) => {
      saved.push(data);
      return Promise.resolve(data);
    }),
  };

  const dataSource = {
    getRepository: jest.fn().mockReturnValue({ findOne }),
    transaction: <T>(cb: (m: unknown) => Promise<T>) => cb(manager),
  };
  const sendPasswordResetEmailAction = { execute: jest.fn().mockResolvedValue(emailSent) };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue({ activationBaseUrl: 'https://placepos.kikedevs.com' }),
  };

  const action = new RequestPasswordResetAction(
    dataSource as never,
    sendPasswordResetEmailAction as never,
    configService as never,
  );
  return { action, findOne, saved, invalidated, sendPasswordResetEmailAction };
}

const ACTIVE_USER = {
  id: '7',
  name: 'Enrique',
  email: 'kike@esenciaygrano.com',
  activated_at: new Date('2026-08-01T10:00:00.000Z'),
};

describe('RequestPasswordResetAction', () => {
  it('emite el enlace y lo envía por correo', async () => {
    const { action, sendPasswordResetEmailAction } = build({ user: { ...ACTIVE_USER } });

    const result = await action.execute('kike@esenciaygrano.com');

    expect(result).toEqual({ sent: true, email: 'k***e@esenciaygrano.com' });
    const sent = sendPasswordResetEmailAction.execute.mock.calls[0][0] as {
      customer_name: string;
      customer_email: string;
      reset_url: string;
    };
    expect(sent.customer_email).toBe('kike@esenciaygrano.com');
    expect(sent.reset_url).toMatch(
      /^https:\/\/placepos\.kikedevs\.com\/restablecer\?token=[0-9a-f]{64}$/,
    );
  });

  it('guarda el HASH del token, nunca el que viaja en el correo', async () => {
    const { action, saved, sendPasswordResetEmailAction } = build({ user: { ...ACTIVE_USER } });

    await action.execute('kike@esenciaygrano.com');

    const url = (sendPasswordResetEmailAction.execute.mock.calls[0][0] as { reset_url: string })
      .reset_url;
    const tokenEnClaro = new URL(url).searchParams.get('token');
    expect(saved).toHaveLength(1);
    expect(saved[0].token_hash).not.toBe(tokenEnClaro);
    expect(String(saved[0].token_hash)).toHaveLength(64);
  });

  it('invalida los enlaces anteriores del mismo usuario', async () => {
    // Varios enlaces vivos para cambiar la misma contraseña multiplican la
    // superficie sin ninguna ventaja.
    const { action, invalidated } = build({ user: { ...ACTIVE_USER } });

    await action.execute('kike@esenciaygrano.com');

    expect(invalidated).toEqual(['7']);
  });

  it('normaliza el correo antes de buscarlo', async () => {
    // El dominio es insensible a mayúsculas: escribirlo distinto no puede
    // significar "no existe".
    const { action, findOne } = build({ user: { ...ACTIVE_USER } });

    await action.execute('  Kike@ESENCIAYGRANO.com  ');

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'Kike@esenciaygrano.com', type: 'owner' } }),
    );
  });

  it('404 si el correo no existe', async () => {
    const { action, saved } = build({ user: null });

    const error = (await action
      .execute('nadie@ejemplo.com')
      .catch((e: unknown) => e)) as NotFoundException;
    const body = error.getResponse() as { payload: { code: string } };

    expect(error).toBeInstanceOf(NotFoundException);
    expect(body.payload.code).toBe('ACCOUNT_NOT_FOUND');
    expect(saved).toHaveLength(0);
  });

  it('403 si la cuenta no está activada, sin emitir token', async () => {
    // Cambiarle la contraseña no le serviría de nada: seguiría sin poder
    // entrar. Lo que necesita es activar.
    const { action, saved } = build({ user: { ...ACTIVE_USER, activated_at: null } });

    const error = (await action
      .execute('kike@esenciaygrano.com')
      .catch((e: unknown) => e)) as ForbiddenException;
    const body = error.getResponse() as { message: string; payload: { code: string } };

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(body.payload.code).toBe('ACCOUNT_NOT_ACTIVATED');
    expect(body.message).toContain('Activar mi cuenta');
    expect(saved).toHaveLength(0);
  });

  it('falla si el correo no salió, en vez de decir "revisa tu bandeja"', async () => {
    // Decirle a alguien que revise un correo que nunca salió lo deja esperando
    // para siempre.
    const { action } = build({ user: { ...ACTIVE_USER }, emailSent: false });

    const error = (await action
      .execute('kike@esenciaygrano.com')
      .catch((e: unknown) => e)) as BadRequestException;
    const body = error.getResponse() as { payload: { code: string } };

    expect(body.payload.code).toBe('RESET_EMAIL_NOT_SENT');
  });

  it('devuelve el destinatario enmascarado', async () => {
    const { action } = build({ user: { ...ACTIVE_USER } });
    const result = await action.execute('kike@esenciaygrano.com');
    expect(result.email).toBe('k***e@esenciaygrano.com');
  });
});
