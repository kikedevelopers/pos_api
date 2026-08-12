import mailConfig, { resolveMailDriver, type MailConfig } from '@/config/mail.config';

import { createMailDriver } from '../drivers/mail-driver.factory';

const baseConfig = (patch: Partial<MailConfig> = {}): MailConfig => ({
  driver: 'log',
  from: 'PlacePOS <no-reply@kikedevs.com>',
  replyTo: '',
  timeoutMs: 15000,
  resend: { apiKey: '', baseUrl: 'https://api.resend.com' },
  smtp: { host: '', port: 2525, username: '', password: '', secure: false },
  ...patch,
});

describe('resolveMailDriver', () => {
  it('respeta el valor explícito de MAIL_DRIVER', () => {
    expect(resolveMailDriver('resend', { hasResendKey: false, hasSmtpHost: true })).toBe('resend');
    expect(resolveMailDriver('smtp', { hasResendKey: true, hasSmtpHost: false })).toBe('smtp');
    expect(resolveMailDriver('log', { hasResendKey: true, hasSmtpHost: true })).toBe('log');
  });

  it('acepta el valor con espacios y en mayúsculas', () => {
    expect(resolveMailDriver('  RESEND ', { hasResendKey: false, hasSmtpHost: false })).toBe(
      'resend',
    );
  });

  it('cae a la cascada cuando viene vacío o con basura', () => {
    for (const value of [undefined, '', '   ', 'sendgrid']) {
      expect(resolveMailDriver(value, { hasResendKey: true, hasSmtpHost: true })).toBe('resend');
      expect(resolveMailDriver(value, { hasResendKey: false, hasSmtpHost: true })).toBe('smtp');
      expect(resolveMailDriver(value, { hasResendKey: false, hasSmtpHost: false })).toBe('log');
    }
  });
});

describe('createMailDriver', () => {
  it('devuelve el driver que pide la configuración', () => {
    expect(createMailDriver(baseConfig({ driver: 'resend' })).name).toBe('resend');
    expect(createMailDriver(baseConfig({ driver: 'smtp' })).name).toBe('smtp');
    expect(createMailDriver(baseConfig({ driver: 'log' })).name).toBe('log');
  });

  it('reporta configurado solo cuando hay credenciales', () => {
    expect(createMailDriver(baseConfig({ driver: 'resend' })).isConfigured()).toBe(false);
    expect(
      createMailDriver(
        baseConfig({
          driver: 'resend',
          resend: { apiKey: 're_x', baseUrl: 'https://api.resend.com' },
        }),
      ).isConfigured(),
    ).toBe(true);

    expect(createMailDriver(baseConfig({ driver: 'smtp' })).isConfigured()).toBe(false);
    expect(
      createMailDriver(
        baseConfig({
          driver: 'smtp',
          smtp: {
            host: 'sandbox.smtp.mailtrap.io',
            port: 2525,
            username: 'u',
            password: 'p',
            secure: false,
          },
        }),
      ).isConfigured(),
    ).toBe(true);

    // El driver `log` siempre está listo: es la red de seguridad.
    expect(createMailDriver(baseConfig({ driver: 'log' })).isConfigured()).toBe(true);
  });

  it('falla ruidosamente ante un driver desconocido', () => {
    const broken = baseConfig({ driver: 'sendgrid' as MailConfig['driver'] });
    expect(() => createMailDriver(broken)).toThrow('Driver de correo desconocido: sendgrid');
  });
});

describe('mailConfig (lectura del entorno)', () => {
  const ENV_KEYS = [
    'MAIL_DRIVER',
    'MAIL_FROM',
    'MAIL_REPLY_TO',
    'MAIL_TIMEOUT_MS',
    'RESEND_API_KEY',
    'RESEND_BASE_URL',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USERNAME',
    'SMTP_PASSWORD',
    'SMTP_SECURE',
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  });

  const load = (): MailConfig => mailConfig() as unknown as MailConfig;

  it('sin nada configurado cae a `log` con el remitente por defecto', () => {
    const config = load();
    expect(config.driver).toBe('log');
    expect(config.from).toBe('PlacePOS <no-reply@kikedevs.com>');
    expect(config.timeoutMs).toBe(15000);
  });

  it('con RESEND_API_KEY elige resend sin necesidad de MAIL_DRIVER', () => {
    process.env.RESEND_API_KEY = 're_test';
    expect(load().driver).toBe('resend');
  });

  it('con SMTP_HOST y sin llave de Resend elige smtp', () => {
    process.env.SMTP_HOST = 'sandbox.smtp.mailtrap.io';
    expect(load().driver).toBe('smtp');
  });

  it('MAIL_DRIVER manda sobre la cascada', () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.SMTP_HOST = 'sandbox.smtp.mailtrap.io';
    process.env.MAIL_DRIVER = 'smtp';
    expect(load().driver).toBe('smtp');
  });

  it('deduce TLS implícito solo en el puerto 465', () => {
    process.env.SMTP_PORT = '465';
    expect(load().smtp.secure).toBe(true);
    process.env.SMTP_PORT = '2525';
    expect(load().smtp.secure).toBe(false);
    process.env.SMTP_PORT = '587';
    expect(load().smtp.secure).toBe(false);
  });

  it('SMTP_SECURE explícito manda sobre el puerto', () => {
    process.env.SMTP_PORT = '2525';
    process.env.SMTP_SECURE = 'true';
    expect(load().smtp.secure).toBe(true);
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'false';
    expect(load().smtp.secure).toBe(false);
  });

  it('quita la barra final de la base de Resend', () => {
    process.env.RESEND_BASE_URL = 'https://api.resend.com/';
    expect(load().resend.baseUrl).toBe('https://api.resend.com');
  });

  it('cae al puerto por defecto si SMTP_PORT no es un número', () => {
    process.env.SMTP_PORT = 'no-es-un-puerto';
    expect(load().smtp.port).toBe(2525);
  });
});
