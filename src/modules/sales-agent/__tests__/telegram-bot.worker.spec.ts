import { conversationIdOf, TelegramBotWorker } from '../channels/telegram/telegram-bot.worker';
import type { TelegramClient, TelegramIncomingMessage } from '../channels/telegram/telegram.client';
import { AUDIO_NOT_UNDERSTOOD_REPLY, type SalesAgentService } from '../seller-agent.service';
import type { SalesBotTakeoverService } from '../sales-bot-takeover.service';
import type { SellerSessionStore } from '../internal/session-store';
import type { ClosedOrder } from '../internal/types';

const COMPANY_ID = 7;

const order: ClosedOrder = {
  items: [{ name: 'Arroz x 500g', quantity: 2, unit_price: 3000, line_total: 6000 }],
  total: 6000,
  channel: 'telegram',
  chat_id: '900',
};

const clientMessage = (
  overrides: Partial<TelegramIncomingMessage> = {},
): TelegramIncomingMessage => ({
  updateId: 1,
  chatId: '900',
  text: 'Hola, ¿tienes arroz?',
  senderName: 'Ana',
  ...overrides,
});

const businessMessage = (
  overrides: Partial<TelegramIncomingMessage> = {},
): TelegramIncomingMessage =>
  clientMessage({
    businessConnectionId: 'BC-1',
    fromBusinessSide: false,
    sentByBot: false,
    ...overrides,
  });

const makeWorker = (ownerChatId: string | null = '111') => {
  const sendMessage = jest.fn().mockResolvedValue(undefined);
  const sendTyping = jest.fn().mockResolvedValue(undefined);
  const downloadFile = jest.fn().mockResolvedValue({ data: 'T2dnUw==' });
  const client = { sendMessage, sendTyping, downloadFile } as unknown as TelegramClient;

  const handleMessage = jest.fn().mockResolvedValue({ reply: 'Claro, ¿cuánto?', orders: [] });
  const greeting = jest.fn().mockResolvedValue('¡Hola! Soy Diana.');
  const transcribeAudio = jest.fn().mockResolvedValue('¿tienes maní dulce?');
  const agent = { handleMessage, greeting, transcribeAudio } as unknown as SalesAgentService;

  const reset = jest.fn();
  const markDay = jest.fn().mockReturnValue(true);
  const append = jest.fn((_key: string, turn: unknown) => [turn]);
  const rememberOrder = jest.fn().mockReturnValue(true);
  const sessions = { reset, markDay, append, rememberOrder } as unknown as SellerSessionStore;

  const isPaused = jest.fn().mockResolvedValue(false);
  const pause = jest.fn().mockResolvedValue({ paused_until: '2026-10-31T05:00:00.000Z' });
  const takeovers = { isPaused, pause } as unknown as SalesBotTakeoverService;

  const worker = new TelegramBotWorker({
    companyId: COMPANY_ID,
    token: 'token',
    ownerChatId,
    pollIntervalMs: 0,
    longPollTimeoutSec: 0,
    agent,
    sessions,
    takeovers,
    client,
  });

  return {
    worker,
    downloadFile,
    transcribeAudio,
    sendMessage,
    sendTyping,
    handleMessage,
    greeting,
    reset,
    markDay,
    append,
    rememberOrder,
    isPaused,
    pause,
  };
};

describe('conversationIdOf', () => {
  it('un chat directo con el bot usa el chat id tal cual', () => {
    expect(conversationIdOf(clientMessage())).toBe('900');
  });

  it('un chat de la cuenta Business va aparte con prefijo b:', () => {
    expect(conversationIdOf(businessMessage())).toBe('b:900');
  });
});

describe('TelegramBotWorker.process — chat directo', () => {
  it('responde al cliente y guarda los turnos', async () => {
    const h = makeWorker();
    await h.worker.process(clientMessage());

    expect(h.sendTyping).toHaveBeenCalledWith('900', undefined);
    expect(h.handleMessage).toHaveBeenCalledWith(
      {
        companyId: COMPANY_ID,
        channel: 'telegram',
        chatId: '900',
        chatDisplayName: 'Ana',
        conversation: { companyId: COMPANY_ID, channel: 'telegram', chatId: '900' },
      },
      expect.any(Array),
      { firstMessageOfDay: true },
    );
    expect(h.sendMessage).toHaveBeenCalledWith('900', 'Claro, ¿cuánto?', undefined);
    expect(h.append).toHaveBeenCalledTimes(2);
  });

  it('ignora updates sin texto (fotos, stickers)', async () => {
    const h = makeWorker();
    await h.worker.process(clientMessage({ text: '' }));
    expect(h.handleMessage).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('/start reinicia la sesión y saluda sin llamar a la IA de conversación', async () => {
    const h = makeWorker();
    await h.worker.process(clientMessage({ text: '/start' }));
    expect(h.reset).toHaveBeenCalled();
    expect(h.greeting).toHaveBeenCalledWith(COMPANY_ID);
    expect(h.sendMessage).toHaveBeenCalledWith('900', '¡Hola! Soy Diana.', undefined);
    expect(h.handleMessage).not.toHaveBeenCalled();
  });

  it('avisa al dueño de un pedido cerrado una sola vez', async () => {
    const h = makeWorker();
    h.handleMessage.mockResolvedValue({ reply: 'Listo', orders: [order] });
    h.rememberOrder.mockReturnValueOnce(true).mockReturnValueOnce(false);

    await h.worker.process(clientMessage());
    await h.worker.process(clientMessage());

    const ownerCalls = h.sendMessage.mock.calls.filter(([chat]) => chat === '111');
    expect(ownerCalls).toHaveLength(1);
  });

  it('sin chat del dueño no intenta avisar', async () => {
    const h = makeWorker(null);
    h.handleMessage.mockResolvedValue({ reply: 'Listo', orders: [order] });
    await h.worker.process(clientMessage());
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('TelegramBotWorker.process — Telegram Business y toma de control', () => {
  it('responde por la conexión Business y usa la conversación b:', async () => {
    const h = makeWorker();
    await h.worker.process(businessMessage());

    expect(h.isPaused).toHaveBeenCalledWith(COMPANY_ID, 'telegram', 'b:900');
    expect(h.sendTyping).toHaveBeenCalledWith('900', 'BC-1');
    expect(h.sendMessage).toHaveBeenCalledWith('900', 'Claro, ¿cuánto?', 'BC-1');
    expect(h.markDay).toHaveBeenCalledWith(
      { companyId: COMPANY_ID, channel: 'telegram', chatId: 'b:900' },
      expect.any(String),
    );
  });

  it('si el dueño escribe en el chat, pausa el agente y no responde', async () => {
    const h = makeWorker();
    await h.worker.process(businessMessage({ fromBusinessSide: true, text: 'yo le atiendo' }));

    expect(h.pause).toHaveBeenCalledWith(COMPANY_ID, 'telegram', 'b:900');
    expect(h.handleMessage).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('una foto del dueño (sin texto) también toma el control', async () => {
    const h = makeWorker();
    await h.worker.process(businessMessage({ fromBusinessSide: true, text: '' }));
    expect(h.pause).toHaveBeenCalledWith(COMPANY_ID, 'telegram', 'b:900');
  });

  it('los mensajes que envió el propio bot NO cuentan como toma de control', async () => {
    const h = makeWorker();
    await h.worker.process(businessMessage({ fromBusinessSide: true, sentByBot: true }));
    expect(h.pause).not.toHaveBeenCalled();
    expect(h.handleMessage).not.toHaveBeenCalled();
  });

  it('con el chat pausado no responde al cliente', async () => {
    const h = makeWorker();
    h.isPaused.mockResolvedValue(true);
    await h.worker.process(businessMessage());
    expect(h.handleMessage).not.toHaveBeenCalled();
    expect(h.sendTyping).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('con el chat pausado tampoco responde a /start', async () => {
    const h = makeWorker();
    h.isPaused.mockResolvedValue(true);
    await h.worker.process(businessMessage({ text: '/start' }));
    expect(h.greeting).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('si una persona toma el chat mientras la IA piensa, descarta la respuesta', async () => {
    const h = makeWorker();
    h.isPaused.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    h.handleMessage.mockResolvedValue({ reply: 'Listo', orders: [order] });

    await h.worker.process(businessMessage());

    expect(h.handleMessage).toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.append).toHaveBeenCalledTimes(1);
  });
});

describe('TelegramBotWorker.process — notas de voz', () => {
  const voiceMessage = (overrides: Partial<TelegramIncomingMessage> = {}) =>
    clientMessage({ text: '', voice: { fileId: 'F1', mimeType: 'audio/ogg' }, ...overrides });

  it('descarga y transcribe la nota de voz, y la atiende como texto', async () => {
    const h = makeWorker();
    await h.worker.process(voiceMessage());

    expect(h.downloadFile).toHaveBeenCalledWith('F1');
    expect(h.transcribeAudio).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      data: 'T2dnUw==',
      mime_type: 'audio/ogg',
    });
    const [, turns] = h.handleMessage.mock.calls[0];
    expect(turns[turns.length - 1]).toEqual({ role: 'user', content: '¿tienes maní dulce?' });
    expect(h.sendMessage).toHaveBeenCalledWith('900', 'Claro, ¿cuánto?', undefined);
  });

  it('si no se entiende, pide que lo escriba (por la conexión Business si aplica)', async () => {
    const h = makeWorker();
    h.transcribeAudio.mockResolvedValue(null);
    await h.worker.process(voiceMessage({ businessConnectionId: 'BC-1', fromBusinessSide: false }));
    expect(h.sendMessage).toHaveBeenCalledWith('900', AUDIO_NOT_UNDERSTOOD_REPLY, 'BC-1');
    expect(h.handleMessage).not.toHaveBeenCalled();
  });

  it('si la descarga falla, no transcribe y pide que lo escriba', async () => {
    const h = makeWorker();
    h.downloadFile.mockResolvedValue(null);
    await h.worker.process(voiceMessage());
    expect(h.transcribeAudio).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledWith('900', AUDIO_NOT_UNDERSTOOD_REPLY, undefined);
  });

  it('con el chat pausado no descarga ni transcribe', async () => {
    const h = makeWorker();
    h.isPaused.mockResolvedValue(true);
    await h.worker.process(voiceMessage({ businessConnectionId: 'BC-1' }));
    expect(h.downloadFile).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('una nota de voz del DUEÑO en un chat Business toma el control (no se transcribe)', async () => {
    const h = makeWorker();
    await h.worker.process(
      voiceMessage({ businessConnectionId: 'BC-1', fromBusinessSide: true, sentByBot: false }),
    );
    expect(h.pause).toHaveBeenCalled();
    expect(h.downloadFile).not.toHaveBeenCalled();
  });
});
