import { ServiceUnavailableException } from '@nestjs/common';

import { SendTestEmailAction } from '../actions/send-test-email.action';
import { MailDeliveryError } from '../drivers/mail-driver.interface';
import type { MailService } from '../mail.service';

const buildMailService = (overrides: Partial<MailService> = {}): jest.Mocked<MailService> =>
  ({
    isEnabled: jest.fn().mockReturnValue(true),
    providerName: 'resend',
    defaultFrom: 'PlacePOS <no-reply@kikedevs.com>',
    send: jest.fn().mockResolvedValue({ messageId: 'msg_1', provider: 'resend', durationMs: 412 }),
    ...overrides,
  }) as unknown as jest.Mocked<MailService>;

describe('SendTestEmailAction', () => {
  it('envía el correo de prueba y devuelve el destinatario enmascarado', async () => {
    const mailService = buildMailService();
    const result = await new SendTestEmailAction(mailService).execute('kike@esenciaygrano.com');

    expect(result).toMatchObject({
      ok: true,
      to: 'k***e@esenciaygrano.com',
      provider: 'resend',
      messageId: 'msg_1',
      durationMs: 412,
    });
    expect(result.message).toContain('enviado');
  });

  it('el correo lleva proveedor, entorno y remitente para saber de DÓNDE salió', async () => {
    const mailService = buildMailService();
    await new SendTestEmailAction(mailService).execute('kike@esenciaygrano.com');

    const sent = mailService.send.mock.calls[0][0];
    expect(sent.to).toBe('kike@esenciaygrano.com');
    expect(sent.subject).toContain('PlacePOS');
    expect(sent.html).toContain('resend');
    expect(sent.html).toContain('no-reply@kikedevs.com');
    // La alternativa en texto plano es obligatoria: sin ella los filtros de
    // spam castigan el envío.
    expect(sent.text.length).toBeGreaterThan(0);
    expect(sent.text).toContain('Proveedor: resend');
  });

  it('sin proveedor configurado responde 503 y no intenta enviar', async () => {
    const send = jest.fn();
    const mailService = buildMailService({ isEnabled: jest.fn().mockReturnValue(false), send });
    await expect(new SendTestEmailAction(mailService).execute('a@x.com')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('un rechazo del proveedor vuelve como ok:false, no como excepción', async () => {
    // El fallo ES el diagnóstico que se pidió: llega mejor como resultado que
    // como un 500 que el panel tiene que interpretar.
    const mailService = buildMailService({
      send: jest
        .fn()
        .mockRejectedValue(
          new MailDeliveryError(
            'El dominio del remitente no está verificado.',
            'resend',
            false,
            'crudo',
          ),
        ),
    });

    const result = await new SendTestEmailAction(mailService).execute('kike@esenciaygrano.com');

    expect(result.ok).toBe(false);
    expect(result.provider).toBe('resend');
    expect(result.messageId).toBeNull();
    expect(result.message).toContain('dominio del remitente');
    // El detalle técnico se queda en el log del servidor.
    expect(result.message).not.toContain('crudo');
  });

  it('propaga los errores que NO son de entrega (p. ej. dirección inválida)', async () => {
    const mailService = buildMailService({
      send: jest.fn().mockRejectedValue(new Error('Dirección de correo inválida')),
    });
    await expect(new SendTestEmailAction(mailService).execute('a@x.com')).rejects.toThrow(
      'Dirección de correo inválida',
    );
  });

  it('en modo log avisa de que el correo NO salió', async () => {
    const mailService = buildMailService({
      providerName: 'log',
      send: jest.fn().mockResolvedValue({ messageId: null, provider: 'log', durationMs: 1 }),
    });
    const result = await new SendTestEmailAction(mailService).execute('a@x.com');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no se envió');
  });
});
