import { ConflictException, NotFoundException } from '@nestjs/common';

import { ResendActivationAction } from '../resend-activation.action';

const EXPIRES_AT = new Date('2026-08-19T10:00:00.000Z');

interface Scenario {
  owner?: {
    id: string;
    name: string;
    email: string;
    activated_at: Date | null;
    company: { name: string } | null;
  } | null;
  /** Qué devuelve el envío del correo. */
  emailSent?: boolean;
}

function build({ owner = null, emailSent = true }: Scenario = {}) {
  const findOne = jest.fn().mockResolvedValue(owner);
  const dataSource = {
    getRepository: jest.fn().mockReturnValue({ findOne }),
    transaction: <T>(cb: (m: unknown) => Promise<T>) => cb({}),
  };
  const issueActivationTokenAction = {
    execute: jest.fn().mockResolvedValue({ token: 'a'.repeat(64), expiresAt: EXPIRES_AT }),
  };
  const sendWelcomeEmailAction = { execute: jest.fn().mockResolvedValue(emailSent) };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue({ activationBaseUrl: 'https://placepos.kikedevs.com' }),
  };

  const action = new ResendActivationAction(
    dataSource as never,
    issueActivationTokenAction,
    sendWelcomeEmailAction as never,
    configService as never,
  );
  return { action, issueActivationTokenAction, sendWelcomeEmailAction, findOne };
}

const PENDING_OWNER = {
  id: '7',
  name: 'Enrique',
  email: 'kike@esenciaygrano.com',
  activated_at: null as Date | null,
  company: { name: 'Esencia & Grano' },
};

describe('ResendActivationAction', () => {
  it('reemite el enlace y reenvía el correo', async () => {
    const { action, issueActivationTokenAction, sendWelcomeEmailAction } = build({
      owner: { ...PENDING_OWNER },
    });

    const result = await action.execute(8);

    expect(result).toEqual({
      sent: true,
      email: 'kike@esenciaygrano.com',
      expiresAt: EXPIRES_AT.toISOString(),
    });
    expect(issueActivationTokenAction.execute).toHaveBeenCalledTimes(1);
    expect(sendWelcomeEmailAction.execute).toHaveBeenCalledWith({
      customer_name: 'Enrique',
      customer_email: 'kike@esenciaygrano.com',
      company_name: 'Esencia & Grano',
      activation_url: `https://placepos.kikedevs.com/activar?token=${'a'.repeat(64)}`,
    });
  });

  it('devuelve el correo SIN enmascarar', async () => {
    // Al revés que en los logs: el operador acaba de reenviar y necesita
    // confirmar a qué dirección fue.
    const { action } = build({ owner: { ...PENDING_OWNER } });
    const result = await action.execute(8);
    expect(result.email).toBe('kike@esenciaygrano.com');
  });

  it('404 si la company no tiene owner', async () => {
    const { action, issueActivationTokenAction } = build({ owner: null });

    await expect(action.execute(8)).rejects.toBeInstanceOf(NotFoundException);
    expect(issueActivationTokenAction.execute).not.toHaveBeenCalled();
  });

  it('409 si la cuenta ya está activada, sin tocar el token', async () => {
    // Reemitir invalidaría un enlace que ya no hace falta y le mandaría al
    // cliente un correo pidiéndole algo que ya hizo.
    const { action, issueActivationTokenAction, sendWelcomeEmailAction } = build({
      owner: { ...PENDING_OWNER, activated_at: new Date('2026-08-11T10:00:00.000Z') },
    });

    const error = (await action.execute(8).catch((e: unknown) => e)) as ConflictException;
    const body = error.getResponse() as { payload: { code: string } };

    expect(error).toBeInstanceOf(ConflictException);
    expect(body.payload.code).toBe('ACCOUNT_ALREADY_ACTIVATED');
    expect(issueActivationTokenAction.execute).not.toHaveBeenCalled();
    expect(sendWelcomeEmailAction.execute).not.toHaveBeenCalled();
  });

  it('falla si el correo no sale, en vez de decir que sí salió', async () => {
    // El operador pulsó "reenviar": dar por bueno un envío que no ocurrió lo
    // dejaría esperando una respuesta del cliente que nunca va a llegar.
    const { action } = build({ owner: { ...PENDING_OWNER }, emailSent: false });

    const error = (await action.execute(8).catch((e: unknown) => e)) as ConflictException;
    const body = error.getResponse() as { message: string; payload: { code: string } };

    expect(body.payload.code).toBe('ACTIVATION_EMAIL_NOT_SENT');
    expect(body.message).toContain('servidor de envíos');
  });

  it('funciona aunque el owner no tenga company asociada', async () => {
    const { action, sendWelcomeEmailAction } = build({
      owner: { ...PENDING_OWNER, company: null },
    });

    await action.execute(8);

    expect(sendWelcomeEmailAction.execute).toHaveBeenCalledWith(
      expect.objectContaining({ company_name: '' }),
    );
  });

  it('busca al OWNER de esa company, no a cualquier usuario', async () => {
    const { action, findOne } = build({ owner: { ...PENDING_OWNER } });

    await action.execute(8);

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { company_id: '8', type: 'owner' } }),
    );
  });
});
