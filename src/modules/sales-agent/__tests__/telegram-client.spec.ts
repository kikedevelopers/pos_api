import { chunkText, TelegramClient } from '../channels/telegram/telegram.client';

const okJson = (body: unknown): Response =>
  ({ json: async () => body }) as unknown as Response;

describe('chunkText', () => {
  it('deja un texto corto en una sola parte', () => {
    expect(chunkText('hola', 4000)).toEqual(['hola']);
  });

  it('un texto vacío no produce partes', () => {
    expect(chunkText('   ', 4000)).toEqual([]);
  });

  it('trocea un texto largo en partes que caben en el límite', () => {
    const long = 'a'.repeat(9000);
    const chunks = chunkText(long, 4000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
    expect(chunks.join('').length).toBe(9000);
  });
});

describe('TelegramClient.getUpdates', () => {
  afterEach(() => jest.restoreAllMocks());

  it('normaliza mensajes de texto con nombre del remitente', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      okJson({
        ok: true,
        result: [
          {
            update_id: 10,
            message: {
              chat: { id: 555 },
              text: '  Hola, ¿tienes arroz?  ',
              from: { first_name: 'María', last_name: 'G' },
            },
          },
        ],
      }),
    );
    const client = new TelegramClient('token');
    const messages = await client.getUpdates(0, 0);
    expect(messages).toEqual([
      { updateId: 10, chatId: '555', text: 'Hola, ¿tienes arroz?', senderName: 'María G' },
    ]);
  });

  it('a un update sin texto (foto/sticker) le deja text vacío para avanzar el offset', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      okJson({ ok: true, result: [{ update_id: 11, message: { chat: { id: 7 } } }] }),
    );
    const client = new TelegramClient('token');
    const messages = await client.getUpdates(0, 0);
    expect(messages).toEqual([{ updateId: 11, chatId: '7', text: '' }]);
  });

  it('ante error de red devuelve lista vacía (no lanza)', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    const client = new TelegramClient('token');
    await expect(client.getUpdates(0, 0)).resolves.toEqual([]);
  });

  it('usa @username cuando no hay nombre', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      okJson({
        ok: true,
        result: [
          { update_id: 1, message: { chat: { id: 1 }, text: 'hi', from: { username: 'pepe' } } },
        ],
      }),
    );
    const client = new TelegramClient('token');
    const [message] = await client.getUpdates(0, 0);
    expect(message.senderName).toBe('@pepe');
  });
});

describe('TelegramClient.sendMessage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('envía el texto como un sendMessage por parte', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okJson({ ok: true }));
    const client = new TelegramClient('token');
    await client.sendMessage('42', 'Claro que sí 😊');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/sendMessage');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      chat_id: '42',
      text: 'Claro que sí 😊',
    });
  });

  it('trocea un texto larguísimo en varios envíos', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okJson({ ok: true }));
    const client = new TelegramClient('token');
    await client.sendMessage('42', 'x'.repeat(9000));
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
