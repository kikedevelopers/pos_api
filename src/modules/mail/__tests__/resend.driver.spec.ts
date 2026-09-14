import type { MailConfig } from '@/config/mail.config';

import { MailDeliveryError } from '../drivers/mail-driver.interface';
import { ResendDriver } from '../drivers/resend.driver';

const config = (patch: Partial<MailConfig> = {}): MailConfig => ({
  driver: 'resend',
  from: 'PlacePOS <no-reply@kikedevs.com>',
  replyTo: '',
  timeoutMs: 5000,
  resend: { apiKey: 're_test', baseUrl: 'https://api.resend.com' },
  smtp: { host: '', port: 2525, username: '', password: '', secure: false },
  ...patch,
});

const message = {
  to: ['kike@esenciaygrano.com'],
  subject: 'Prueba',
  html: '<p>hola</p>',
  text: 'hola',
};

/** Respuesta mínima con la forma que consume el driver. */
const httpResponse = (status: number, body: string): Response =>
  ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) }) as Response;

/** Argumentos con los que se llamó a `fetch` en la llamada indicada. */
const callAt = (fetchMock: jest.SpyInstance, index: number): [string, RequestInit] =>
  fetchMock.mock.calls[index] as [string, RequestInit];

/** Cuerpo JSON que el driver le mandó al proveedor. */
const bodyAt = (fetchMock: jest.SpyInstance, index: number): Record<string, unknown> =>
  JSON.parse(callAt(fetchMock, index)[1].body as string) as Record<string, unknown>;

describe('ResendDriver.send', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('envía y devuelve el id del proveedor', async () => {
    fetchMock.mockResolvedValue(httpResponse(200, JSON.stringify({ id: 'msg_123' })));

    const result = await new ResendDriver(config()).send(message);

    expect(result.messageId).toBe('msg_123');
    expect(result.provider).toBe('resend');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const [url, init] = callAt(fetchMock, 0);
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    const body = bodyAt(fetchMock, 0);
    expect(body.from).toBe('PlacePOS <no-reply@kikedevs.com>');
    expect(body.to).toEqual(['kike@esenciaygrano.com']);
    expect(body.text).toBe('hola');
  });

  it('respeta el remitente del mensaje sobre el de la configuración', async () => {
    fetchMock.mockResolvedValue(httpResponse(200, '{}'));
    await new ResendDriver(config()).send({ ...message, from: 'Otro <otro@x.com>' });
    expect(bodyAt(fetchMock, 0).from).toBe('Otro <otro@x.com>');
  });

  it('incluye reply_to, cc y bcc solo cuando existen', async () => {
    fetchMock.mockResolvedValue(httpResponse(200, '{}'));

    await new ResendDriver(config()).send(message);
    const sinExtras = bodyAt(fetchMock, 0);
    expect(sinExtras).not.toHaveProperty('reply_to');
    expect(sinExtras).not.toHaveProperty('cc');
    expect(sinExtras).not.toHaveProperty('bcc');

    await new ResendDriver(config({ replyTo: 'hola@placepos.com' })).send({
      ...message,
      cc: ['cc@x.com'],
      bcc: [],
    });
    const conExtras = bodyAt(fetchMock, 1);
    expect(conExtras.reply_to).toBe('hola@placepos.com');
    expect(conExtras.cc).toEqual(['cc@x.com']);
    // bcc vacío NO se manda: algunos proveedores rechazan el arreglo vacío.
    expect(conExtras).not.toHaveProperty('bcc');
  });

  it('acepta un 200 cuyo cuerpo no es JSON', async () => {
    fetchMock.mockResolvedValue(httpResponse(200, 'OK'));
    const result = await new ResendDriver(config()).send(message);
    expect(result.messageId).toBeNull();
  });

  it('traduce el rechazo por dominio sin verificar y NO lo marca reintentable', async () => {
    fetchMock.mockResolvedValue(
      httpResponse(422, JSON.stringify({ message: 'The kikedevs.com domain is not verified.' })),
    );

    await expect(new ResendDriver(config()).send(message)).rejects.toMatchObject({
      name: 'MailDeliveryError',
      provider: 'resend',
      retriable: false,
      message: expect.stringContaining('dominio del remitente no está verificado') as unknown,
      detail: 'The kikedevs.com domain is not verified.',
    });
  });

  it('traduce la llave inválida', async () => {
    fetchMock.mockResolvedValue(httpResponse(401, JSON.stringify({ message: 'Invalid API key' })));
    await expect(new ResendDriver(config()).send(message)).rejects.toThrow('RESEND_API_KEY');
  });

  it('marca reintentables los 5xx y el 429', async () => {
    for (const status of [500, 503, 429]) {
      fetchMock.mockResolvedValue(httpResponse(status, ''));
      const error = await new ResendDriver(config()).send(message).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MailDeliveryError);
      expect((error as MailDeliveryError).retriable).toBe(true);
    }
  });

  it('trata el fallo de red como reintentable', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('fetch failed'), { name: 'TypeError' }));
    const error = await new ResendDriver(config()).send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect((error as MailDeliveryError).retriable).toBe(true);
    expect((error as MailDeliveryError).message).toContain('No se pudo conectar');
  });

  it('traduce el timeout sin filtrar el error crudo', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }),
    );
    const error = await new ResendDriver(config()).send(message).catch((e: unknown) => e);
    expect((error as MailDeliveryError).message).toContain('tardó demasiado');
  });
});

describe('ResendDriver.verify', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('sin llave reporta el motivo y no llama a la red', async () => {
    const health = await new ResendDriver(
      config({ resend: { apiKey: '', baseUrl: 'https://api.resend.com' } }),
    ).verify();
    expect(health).toEqual({
      healthy: false,
      detail: 'Falta RESEND_API_KEY en el servidor.',
      latencyMs: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('credencial válida → sano, con latencia medida', async () => {
    fetchMock.mockResolvedValue(httpResponse(200, JSON.stringify({ data: [] })));
    const health = await new ResendDriver(config()).verify();
    expect(health.healthy).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(callAt(fetchMock, 0)[0]).toBe('https://api.resend.com/domains');
  });

  it('una llave SOLO de envío sigue siendo válida', async () => {
    // Resend responde 401 "restricted" a las llaves con permiso de envío
    // únicamente. Pintarlas en rojo dejaría el panel alarmado con todo bien.
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValue(
        httpResponse(
          status,
          JSON.stringify({ message: 'This API key is restricted to only send emails' }),
        ),
      );
      const health = await new ResendDriver(config()).verify();
      expect(health.healthy).toBe(true);
      expect(health.detail).toContain('solo de envío');
    }
  });

  it('una llave realmente inválida sí reporta caída', async () => {
    fetchMock.mockResolvedValue(
      httpResponse(401, JSON.stringify({ message: 'API key is invalid' })),
    );
    const health = await new ResendDriver(config()).verify();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain('RESEND_API_KEY');
  });

  it('el proveedor caído se reporta, nunca se lanza', async () => {
    fetchMock.mockResolvedValue(httpResponse(503, ''));
    await expect(new ResendDriver(config()).verify()).resolves.toMatchObject({ healthy: false });

    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(new ResendDriver(config()).verify()).resolves.toMatchObject({
      healthy: false,
      latencyMs: null,
    });
  });
});
