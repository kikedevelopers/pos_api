import { SendWelcomeEmailAction } from '../actions/send-welcome-email.action';
import { MailDeliveryError } from '../drivers/mail-driver.interface';
import type { MailService } from '../mail.service';

const INPUT = {
  customer_name: 'Enrique',
  customer_email: 'kike@esenciaygrano.com',
  company_name: 'Esencia & Grano',
  activation_url:
    'https://placepos.kikedevs.com/activar?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

const buildMailService = (overrides: Partial<MailService> = {}): jest.Mocked<MailService> =>
  ({
    isEnabled: jest.fn().mockReturnValue(true),
    send: jest.fn().mockResolvedValue({ messageId: 'msg_1', provider: 'resend', durationMs: 120 }),
    ...overrides,
  }) as unknown as jest.Mocked<MailService>;

describe('SendWelcomeEmailAction', () => {
  it('envía la bienvenida al correo del dueño', async () => {
    const send = jest.fn().mockResolvedValue({ messageId: 'm', provider: 'resend', durationMs: 1 });
    const action = new SendWelcomeEmailAction(buildMailService({ send }));

    await expect(action.execute(INPUT)).resolves.toBe(true);

    const sent = (send.mock.calls[0] as unknown[])[0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(sent.to).toBe('kike@esenciaygrano.com');
    expect(sent.subject).toContain('Esencia & Grano');
    expect(sent.html).toContain('Enrique');
    expect(sent.text).toContain('Esencia & Grano');
    // Sin el enlace, el correo no sirve para nada: la cuenta no se puede usar.
    expect(sent.html).toContain(INPUT.activation_url);
  });

  it('NUNCA lanza si el proveedor rechaza el envío', async () => {
    // Este correo sale durante el registro: un fallo suyo no puede impedir que
    // alguien cree su cuenta.
    const send = jest
      .fn()
      .mockRejectedValue(new MailDeliveryError('dominio sin verificar', 'resend'));
    const action = new SendWelcomeEmailAction(buildMailService({ send }));

    await expect(action.execute(INPUT)).resolves.toBe(false);
  });

  it('NUNCA lanza si el render de la plantilla falla', async () => {
    const send = jest.fn().mockRejectedValue(new Error('cualquier cosa inesperada'));
    const action = new SendWelcomeEmailAction(buildMailService({ send }));

    await expect(action.execute(INPUT)).resolves.toBe(false);
  });

  it('sin proveedor configurado no intenta enviar y devuelve false', async () => {
    const send = jest.fn();
    const action = new SendWelcomeEmailAction(
      buildMailService({ isEnabled: jest.fn().mockReturnValue(false), send }),
    );

    await expect(action.execute(INPUT)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('no filtra el correo completo del cliente en los logs', async () => {
    // El log de un servidor multi-tenant acaba en archivos y en herramientas de
    // terceros: el correo de un cliente no tiene por qué quedar entero ahí.
    const send = jest.fn().mockRejectedValue(new MailDeliveryError('boom', 'resend'));
    const action = new SendWelcomeEmailAction(buildMailService({ send }));
    const error = jest.fn();
    Object.assign(action as unknown as { logger: unknown }, { logger: { error, log: jest.fn() } });

    await action.execute(INPUT);

    const logged = String((error.mock.calls[0] as unknown[])[0]);
    expect(logged).toContain('k***e@esenciaygrano.com');
    expect(logged).not.toContain('kike@esenciaygrano.com');
  });
});
