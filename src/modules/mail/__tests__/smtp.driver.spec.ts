import { createTransport } from 'nodemailer';

import type { MailConfig } from '@/config/mail.config';

import { MailDeliveryError } from '../drivers/mail-driver.interface';
import { SmtpDriver } from '../drivers/smtp.driver';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const createTransportMock = createTransport as unknown as jest.Mock;

const config = (patch: Partial<MailConfig> = {}): MailConfig => ({
  driver: 'smtp',
  from: 'PlacePOS <no-reply@kikedevs.com>',
  replyTo: '',
  timeoutMs: 5000,
  resend: { apiKey: '', baseUrl: 'https://api.resend.com' },
  smtp: {
    host: 'sandbox.smtp.mailtrap.io',
    port: 2525,
    username: 'ae1c31246490ab',
    password: 'secreta',
    secure: false,
  },
  ...patch,
});

const message = {
  to: ['kike@esenciaygrano.com'],
  subject: 'Prueba',
  html: '<p>hola</p>',
  text: 'hola',
};

interface FakeTransport {
  sendMail: jest.Mock;
  verify: jest.Mock;
}

const transport = (overrides: Partial<FakeTransport> = {}): FakeTransport => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: '<abc@mailtrap>' }),
  verify: jest.fn().mockResolvedValue(true),
  ...overrides,
});

/** Opciones con las que el driver creó el transporte. */
const transportOptions = (): Record<string, unknown> =>
  (createTransportMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;

describe('SmtpDriver.send', () => {
  beforeEach(() => {
    createTransportMock.mockReset();
  });

  it('envía por SMTP y devuelve el messageId', async () => {
    const t = transport();
    createTransportMock.mockReturnValue(t);

    const result = await new SmtpDriver(config()).send(message);

    expect(result).toMatchObject({ messageId: '<abc@mailtrap>', provider: 'smtp' });
    expect(t.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'PlacePOS <no-reply@kikedevs.com>',
        to: ['kike@esenciaygrano.com'],
        subject: 'Prueba',
        text: 'hola',
        replyTo: undefined,
        cc: undefined,
        bcc: undefined,
      }),
    );
  });

  it('crea el transporte con host, puerto y credenciales', async () => {
    createTransportMock.mockReturnValue(transport());
    await new SmtpDriver(config()).send(message);
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'sandbox.smtp.mailtrap.io',
        port: 2525,
        secure: false,
        auth: { user: 'ae1c31246490ab', pass: 'secreta' },
      }),
    );
  });

  it('omite la autenticación en un SMTP sin usuario', async () => {
    createTransportMock.mockReturnValue(transport());
    await new SmtpDriver(
      config({
        smtp: { host: 'localhost', port: 1025, username: '', password: '', secure: false },
      }),
    ).send(message);
    expect(transportOptions().auth).toBeUndefined();
  });

  it('reutiliza el transporte entre envíos', async () => {
    // Abrir una conexión SMTP por correo es caro y Mailtrap limita conexiones.
    createTransportMock.mockReturnValue(transport());
    const driver = new SmtpDriver(config());
    await driver.send(message);
    await driver.send(message);
    expect(createTransportMock).toHaveBeenCalledTimes(1);
  });

  it('traduce el rechazo de credenciales y no lo marca reintentable', async () => {
    createTransportMock.mockReturnValue(
      transport({
        sendMail: jest
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('bad auth'), { code: 'EAUTH', responseCode: 535 }),
          ),
      }),
    );

    const error = await new SmtpDriver(config()).send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect((error as MailDeliveryError).message).toContain('SMTP_USERNAME');
    expect((error as MailDeliveryError).retriable).toBe(false);
    expect((error as MailDeliveryError).detail).toBe('bad auth');
  });

  it('marca reintentable el rechazo temporal 4xx', async () => {
    createTransportMock.mockReturnValue(
      transport({
        sendMail: jest
          .fn()
          .mockRejectedValue(Object.assign(new Error('try later'), { responseCode: 451 })),
      }),
    );
    const error = await new SmtpDriver(config()).send(message).catch((e: unknown) => e);
    expect((error as MailDeliveryError).retriable).toBe(true);
  });

  it('devuelve messageId null si el servidor no lo da', async () => {
    createTransportMock.mockReturnValue(transport({ sendMail: jest.fn().mockResolvedValue({}) }));
    const result = await new SmtpDriver(config()).send(message);
    expect(result.messageId).toBeNull();
  });
});

describe('SmtpDriver.verify', () => {
  beforeEach(() => {
    createTransportMock.mockReset();
  });

  it('sin host reporta el motivo y no abre conexión', async () => {
    const health = await new SmtpDriver(
      config({ smtp: { host: '', port: 2525, username: '', password: '', secure: false } }),
    ).verify();
    expect(health).toEqual({
      healthy: false,
      detail: 'Falta SMTP_HOST en el servidor.',
      latencyMs: null,
    });
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('handshake correcto → sano, con el destino en el detalle', async () => {
    createTransportMock.mockReturnValue(transport());
    const health = await new SmtpDriver(config()).verify();
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain('sandbox.smtp.mailtrap.io:2525');
  });

  it('un servidor caído se reporta, nunca se lanza', async () => {
    createTransportMock.mockReturnValue(
      transport({
        verify: jest
          .fn()
          .mockRejectedValue(Object.assign(new Error('no route'), { code: 'ECONNECTION' })),
      }),
    );
    const health = await new SmtpDriver(config()).verify();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain('SMTP_HOST');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('isConfigured depende solo del host', () => {
    expect(new SmtpDriver(config()).isConfigured()).toBe(true);
    expect(
      new SmtpDriver(
        config({ smtp: { host: '', port: 2525, username: 'u', password: 'p', secure: false } }),
      ).isConfigured(),
    ).toBe(false);
  });
});
