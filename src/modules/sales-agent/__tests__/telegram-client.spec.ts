import {
  chunkText,
  MAX_TELEGRAM_FILE_BYTES,
  TelegramClient,
} from '../channels/telegram/telegram.client';

const okJson = (body: unknown): Response => ({ json: async () => body }) as unknown as Response;

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
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
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

describe('TelegramClient.getUpdates — Telegram Business', () => {
  afterEach(() => jest.restoreAllMocks());

  const businessUpdate = (message: Record<string, unknown>) =>
    okJson({
      ok: true,
      result: [
        {
          update_id: 20,
          business_message: { business_connection_id: 'BC-1', chat: { id: 900 }, ...message },
        },
      ],
    });

  it('pide también los business_message en allowed_updates', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(okJson({ ok: true, result: [] }));
    await new TelegramClient('token').getUpdates(5, 30);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      offset: 5,
      timeout: 30,
      allowed_updates: ['message', 'business_message'],
    });
  });

  it('mensaje del CLIENTE en un chat Business: lado cliente, con conexión y nombre', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(businessUpdate({ text: ' hola ', from: { id: 900, first_name: 'Ana' } }));
    const [message] = await new TelegramClient('token').getUpdates(0, 0);
    expect(message).toEqual({
      updateId: 20,
      chatId: '900',
      text: 'hola',
      businessConnectionId: 'BC-1',
      fromBusinessSide: false,
      sentByBot: false,
      senderName: 'Ana',
    });
  });

  it('mensaje escrito por el DUEÑO: lado negocio, no lo envió el bot', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(businessUpdate({ text: 'yo le atiendo', from: { id: 111 } }));
    const [message] = await new TelegramClient('token').getUpdates(0, 0);
    expect(message).toMatchObject({ fromBusinessSide: true, sentByBot: false });
    expect(message.senderName).toBeUndefined();
  });

  it('mensaje enviado por el bot en nombre del negocio: sentByBot', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        businessUpdate({ text: 'Claro', from: { id: 111 }, sender_business_bot: { id: 77 } }),
      );
    const [message] = await new TelegramClient('token').getUpdates(0, 0);
    expect(message).toMatchObject({ fromBusinessSide: true, sentByBot: true });
  });

  it('una foto del dueño (sin texto) igual se reporta como lado negocio', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(businessUpdate({ from: { id: 111 } }));
    const [message] = await new TelegramClient('token').getUpdates(0, 0);
    expect(message).toMatchObject({ text: '', fromBusinessSide: true, sentByBot: false });
  });

  it('sin remitente no se asume lado negocio', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(businessUpdate({ text: 'hola' }));
    const [message] = await new TelegramClient('token').getUpdates(0, 0);
    expect(message.fromBusinessSide).toBe(false);
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

  it('con conexión Business añade business_connection_id', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okJson({ ok: true }));
    await new TelegramClient('token').sendMessage('900', 'hola', 'BC-1');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      chat_id: '900',
      text: 'hola',
      business_connection_id: 'BC-1',
    });
  });

  it('sin conexión Business no envía business_connection_id', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okJson({ ok: true }));
    await new TelegramClient('token').sendMessage('42', 'hola');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('business_connection_id');
  });
});

describe('TelegramClient.sendTyping', () => {
  afterEach(() => jest.restoreAllMocks());

  it('envía typing y, si hay conexión Business, su id', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okJson({ ok: true }));
    await new TelegramClient('token').sendTyping('900', 'BC-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/sendChatAction');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      chat_id: '900',
      action: 'typing',
      business_connection_id: 'BC-1',
    });
  });
});

describe('TelegramClient — notas de voz', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reporta la nota de voz de un chat directo con su file_id y MIME', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      okJson({
        ok: true,
        result: [
          {
            update_id: 30,
            message: {
              chat: { id: 5 },
              from: { first_name: 'Ana' },
              voice: { file_id: 'F1', mime_type: 'audio/ogg' },
            },
          },
        ],
      }),
    );
    const [message] = await new TelegramClient('token').getUpdates(0, 0);
    expect(message).toEqual({
      updateId: 30,
      chatId: '5',
      text: '',
      voice: { fileId: 'F1', mimeType: 'audio/ogg' },
      senderName: 'Ana',
    });
  });

  it('acepta también "audio" (archivo de audio) y pone MIME por defecto', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      okJson({ ok: true, result: [{ update_id: 31, message: { chat: { id: 5 }, audio: { file_id: 'F2' } } }] }),
    );
    const [message] = await new TelegramClient('token').getUpdates(0, 0);
    expect(message.voice).toEqual({ fileId: 'F2', mimeType: 'audio/ogg' });
  });

  it('downloadFile: getFile + descarga → base64', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(okJson({ ok: true, result: { file_path: 'voice/a.oga', file_size: 4 } }))
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([79, 103, 103, 83]).buffer,
      } as unknown as Response);
    const file = await new TelegramClient('token').downloadFile('F1');
    expect(file).toEqual({ data: 'T2dnUw==' });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/file/bottoken/voice/a.oga');
  });

  it('downloadFile: archivo demasiado grande → null sin descargar', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        okJson({ ok: true, result: { file_path: 'v.oga', file_size: MAX_TELEGRAM_FILE_BYTES + 1 } }),
      );
    await expect(new TelegramClient('token').downloadFile('F1')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('downloadFile: getFile falla o la descarga falla → null', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(okJson({ ok: false, error_code: 400 }));
    await expect(new TelegramClient('token').downloadFile('F1')).resolves.toBeNull();

    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(okJson({ ok: true, result: { file_path: 'v.oga' } }))
      .mockResolvedValueOnce({ ok: false } as unknown as Response);
    await expect(new TelegramClient('token').downloadFile('F1')).resolves.toBeNull();
  });
});
