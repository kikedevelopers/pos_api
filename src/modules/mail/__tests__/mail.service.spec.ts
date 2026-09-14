import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import type { MailConfig } from '@/config/mail.config';

import {
  MAIL_DRIVER,
  MailDeliveryError,
  type MailDriver,
  type MailMessage,
} from '../drivers/mail-driver.interface';
import { MailService } from '../mail.service';

const MAIL_CONFIG: MailConfig = {
  driver: 'resend',
  from: 'PlacePOS <no-reply@kikedevs.com>',
  replyTo: '',
  timeoutMs: 15000,
  resend: { apiKey: 're_test', baseUrl: 'https://api.resend.com' },
  smtp: { host: '', port: 2525, username: '', password: '', secure: false },
};

const okResult = { messageId: 'msg_1', provider: 'resend', durationMs: 10 };

const buildDriver = (overrides: Partial<MailDriver> = {}): jest.Mocked<MailDriver> =>
  ({
    name: 'resend',
    isConfigured: jest.fn().mockReturnValue(true),
    send: jest.fn().mockResolvedValue(okResult),
    verify: jest.fn().mockResolvedValue({ healthy: true, detail: 'ok', latencyMs: 12 }),
    ...overrides,
  }) as unknown as jest.Mocked<MailDriver>;

const buildService = async (driver: MailDriver): Promise<MailService> => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      MailService,
      { provide: MAIL_DRIVER, useValue: driver },
      {
        provide: ConfigService,
        useValue: {
          getOrThrow: (key: string): unknown =>
            key === 'mail' ? MAIL_CONFIG : { nodeEnv: 'test' },
        },
      },
    ],
  }).compile();
  return moduleRef.get(MailService);
};

describe('MailService.send — validación de destinatarios', () => {
  it('rechaza el envío sin destinatarios antes de tocar al proveedor', async () => {
    const send = jest.fn().mockResolvedValue(okResult);
    const service = await buildService(buildDriver({ send }));

    await expect(
      service.send({ to: '', subject: 's', html: 'h', text: 't' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.send({ to: [], subject: 's', html: 'h', text: 't' })).rejects.toThrow(
      'al menos un destinatario',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('rechaza direcciones inválidas y las devuelve enmascaradas', async () => {
    const send = jest.fn().mockResolvedValue(okResult);
    const service = await buildService(buildDriver({ send }));

    const error = await service
      .send({ to: ['ok@x.com', 'sin-arroba'], subject: 's', html: 'h', text: 't' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('inválida');
    // Ni siquiera una dirección mal escrita se devuelve entera.
    expect((error as Error).message).not.toContain('sin-arroba@');
    expect(send).not.toHaveBeenCalled();
  });

  it('normaliza, deduplica y separa por comas antes de enviar', async () => {
    const send = jest.fn().mockResolvedValue(okResult);
    const service = await buildService(buildDriver({ send }));

    await service.send({
      to: ' A@X.COM , b@x.com; a@x.com ',
      subject: 's',
      html: 'h',
      text: 't',
      cc: 'cc@x.com',
      bcc: ['bcc@x.com'],
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['A@x.com', 'b@x.com'],
        cc: ['cc@x.com'],
        bcc: ['bcc@x.com'],
      }),
    );
  });

  it('no inventa cc/bcc cuando no se piden', async () => {
    const send = jest.fn().mockResolvedValue(okResult);
    const service = await buildService(buildDriver({ send }));
    await service.send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' });
    const sent = (send.mock.calls[0] as unknown[])[0] as MailMessage;
    expect(sent.cc).toBeUndefined();
    expect(sent.bcc).toBeUndefined();
  });
});

describe('MailService.send — reintentos', () => {
  it('reintenta UNA vez un fallo transitorio y devuelve el éxito', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new MailDeliveryError('proveedor caído', 'resend', true))
      .mockResolvedValueOnce(okResult);
    const service = await buildService(buildDriver({ send }));

    await expect(
      service.send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' }),
    ).resolves.toEqual(okResult);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('NO reintenta un rechazo definitivo', async () => {
    // Reintentar un dominio sin verificar solo duplica la espera del operador.
    const send = jest
      .fn()
      .mockRejectedValue(new MailDeliveryError('dominio sin verificar', 'resend', false));
    const service = await buildService(buildDriver({ send }));

    await expect(
      service.send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow('dominio sin verificar');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('propaga el fallo si el reintento también falla', async () => {
    const send = jest.fn().mockRejectedValue(new MailDeliveryError('caído', 'resend', true));
    const service = await buildService(buildDriver({ send }));

    await expect(
      service.send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow('caído');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('MailService.getStatus', () => {
  it('combina la salud del proveedor con la actividad real', async () => {
    const service = await buildService(buildDriver());

    await service.send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' });
    const status = await service.getStatus();

    expect(status).toMatchObject({
      driver: 'resend',
      configured: true,
      healthy: true,
      level: 'ok',
      from: 'PlacePOS <no-reply@kikedevs.com>',
      environment: 'test',
    });
    expect(status.activity.sentCount).toBe(1);
    expect(status.activity.lastSuccessAt).not.toBeNull();
    expect(status.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('un envío fallido deja el estado en error aunque la credencial sirva', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(new MailDeliveryError('dominio sin verificar', 'resend'));
    const service = await buildService(buildDriver({ send }));

    await service
      .send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' })
      .catch(() => undefined);
    const status = await service.getStatus();

    expect(status.healthy).toBe(true);
    expect(status.level).toBe('error');
    expect(status.activity.failedCount).toBe(1);
    expect(status.activity.lastErrorMessage).toBe('dominio sin verificar');
  });

  it('un destinatario inválido NO ensucia el estado del servidor', async () => {
    // Es un error de quien llama (un typo del operador en el panel), no una
    // falla del correo. Contarlo pondría el semáforo en rojo por algo que el
    // servidor hace bien: rechazarlo antes de gastar una llamada al proveedor.
    const service = await buildService(buildDriver());
    await service.send({ to: 'basura', subject: 's', html: 'h', text: 't' }).catch(() => undefined);
    const status = await service.getStatus();
    expect(status.activity.failedCount).toBe(0);
    expect(status.level).toBe('ok');
  });

  it('sin credenciales reporta deshabilitado', async () => {
    const driver = buildDriver({
      isConfigured: jest.fn().mockReturnValue(false),
      verify: jest
        .fn()
        .mockResolvedValue({ healthy: false, detail: 'falta llave', latencyMs: null }),
    });
    const status = await (await buildService(driver)).getStatus();
    expect(status.level).toBe('disabled');
    expect(status.configured).toBe(false);
  });

  it('el driver `log` nunca se pinta verde', async () => {
    const driver = buildDriver({
      name: 'log',
      verify: jest.fn().mockResolvedValue({ healthy: true, detail: 'modo local', latencyMs: 0 }),
    });
    const status = await (await buildService(driver)).getStatus();
    expect(status.level).toBe('warning');
  });
});

describe('MailService — utilidades', () => {
  it('expone el proveedor, el remitente y si está habilitado', async () => {
    const service = await buildService(buildDriver());
    expect(service.providerName).toBe('resend');
    expect(service.defaultFrom).toBe('PlacePOS <no-reply@kikedevs.com>');
    expect(service.isEnabled()).toBe(true);
  });

  it('resetActivity limpia los contadores', async () => {
    const service = await buildService(buildDriver());
    await service.send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' });
    service.resetActivity();
    expect((await service.getStatus()).activity.sentCount).toBe(0);
  });
});
