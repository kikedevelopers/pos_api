import { WhatsappWebRelayService } from '../channels/whatsapp-web/whatsapp-web-relay.service';
import { AUDIO_NOT_UNDERSTOOD_REPLY, type SalesAgentService } from '../seller-agent.service';
import type { SalesBotConfigService } from '../sales-bot-config.service';
import type { SalesBotTakeoverService } from '../sales-bot-takeover.service';
import type { SalesAgentAccessService } from '@/modules/sales-agent-access/sales-agent-access.service';
import type { SellerSessionStore } from '../internal/session-store';
import type { SalesBotConfigEntity } from '../entities/sales-bot-config.entity';
import type { ClosedOrder } from '../internal/types';

const incoming = (overrides: Record<string, string> = {}) => ({
  chat_id: '573001112233@s.whatsapp.net',
  text: 'Hola, ¿tienes arroz?',
  sender_name: 'María',
  message_id: 'MSG-1',
  ...overrides,
});

const order: ClosedOrder = {
  items: [{ name: 'Arroz x 500g', quantity: 2, unit_price: 3000, line_total: 6000 }],
  total: 6000,
  channel: 'whatsapp',
  chat_id: '573001112233@s.whatsapp.net',
};

interface Harness {
  relay: WhatsappWebRelayService;
  accessEnabled: jest.Mock;
  assertEnabled: jest.Mock;
  transcribeAudio: jest.Mock;
  handleMessage: jest.Mock;
  greeting: jest.Mock;
  getEntity: jest.Mock;
  isReady: jest.Mock;
  reset: jest.Mock;
  markDay: jest.Mock;
  rememberOrder: jest.Mock;
  isPaused: jest.Mock;
  pause: jest.Mock;
}

const GREETING = '¡Buenos días! 😊 Soy Diana, de Granero La 21. ¿En qué te puedo ayudar hoy?';

const makeRelay = (config: Partial<SalesBotConfigEntity> | null): Harness => {
  const handleMessage = jest.fn().mockResolvedValue({ reply: 'Claro, ¿cuánto?', orders: [] });
  const greeting = jest.fn().mockResolvedValue(GREETING);
  const isReady = jest.fn().mockReturnValue(true);
  const transcribeAudio = jest.fn().mockResolvedValue('¿tienes uva pasa?');
  const agent = { isReady, handleMessage, greeting, transcribeAudio } as unknown as SalesAgentService;

  const reset = jest.fn();
  const markDay = jest.fn().mockReturnValue(true);
  const rememberOrder = jest.fn().mockReturnValue(true);
  const sessions = {
    append: jest.fn((_key: string, turn: unknown) => [turn]),
    reset,
    markDay,
    rememberOrder,
    pruneExpired: jest.fn(),
  } as unknown as SellerSessionStore;

  const getEntity = jest.fn().mockResolvedValue(config);
  const botConfig = { getEntity } as unknown as SalesBotConfigService;

  const isPaused = jest.fn().mockResolvedValue(false);
  const pause = jest.fn().mockResolvedValue({ paused_until: '2026-10-31T05:00:00.000Z' });
  const takeovers = { isPaused, pause } as unknown as SalesBotTakeoverService;

  const accessEnabled = jest.fn().mockResolvedValue(true);
  const assertEnabled = jest.fn().mockResolvedValue(undefined);
  const access = { isEnabled: accessEnabled, assertEnabled } as unknown as SalesAgentAccessService;

  const relay = new WhatsappWebRelayService(agent, sessions, botConfig, takeovers, access);
  return {
    relay,
    accessEnabled,
    assertEnabled,
    transcribeAudio,
    handleMessage,
    greeting,
    getEntity,
    isReady,
    reset,
    markDay,
    rememberOrder,
    isPaused,
    pause,
  };
};

const enabled = (overrides: Partial<SalesBotConfigEntity> = {}) => ({
  channel: 'whatsapp',
  enabled: true,
  owner_chat_id: null,
  ...overrides,
}) as Partial<SalesBotConfigEntity>;

describe('WhatsappWebRelayService.reply', () => {
  it('responde con el texto del vendedor y usa el negocio del token', async () => {
    const h = makeRelay(enabled());
    const result = await h.relay.reply(7, incoming());

    expect(result).toEqual({ reply: 'Claro, ¿cuánto?', notifications: [] });
    expect(h.getEntity).toHaveBeenCalledWith(7, 'whatsapp');
    const [ctx] = h.handleMessage.mock.calls[0];
    expect(ctx).toMatchObject({
      companyId: 7,
      channel: 'whatsapp',
      chatId: '573001112233@s.whatsapp.net',
      chatDisplayName: 'María',
    });
  });

  it('no responde si el asistente de WhatsApp está apagado', async () => {
    const h = makeRelay(enabled({ enabled: false }));
    await expect(h.relay.reply(7, incoming())).resolves.toEqual({
      reply: null,
      notifications: [],
    });
    expect(h.handleMessage).not.toHaveBeenCalled();
  });

  it('no responde si el negocio no tiene config de WhatsApp', async () => {
    const h = makeRelay(null);
    await expect(h.relay.reply(7, incoming())).resolves.toEqual({
      reply: null,
      notifications: [],
    });
  });

  it('no responde si la IA no está lista', async () => {
    const h = makeRelay(enabled());
    h.isReady.mockReturnValue(false);
    await expect(h.relay.reply(7, incoming())).resolves.toEqual({
      reply: null,
      notifications: [],
    });
    expect(h.handleMessage).not.toHaveBeenCalled();
  });

  it('ignora texto vacío o chat vacío', async () => {
    const h = makeRelay(enabled());
    await expect(h.relay.reply(7, incoming({ text: '   ' }))).resolves.toEqual({
      reply: null,
      notifications: [],
    });
    await expect(h.relay.reply(7, incoming({ chat_id: '' }))).resolves.toEqual({
      reply: null,
      notifications: [],
    });
    expect(h.handleMessage).not.toHaveBeenCalled();
  });

  it('no responde dos veces el mismo message_id del mismo negocio', async () => {
    const h = makeRelay(enabled());
    await h.relay.reply(7, incoming());
    const second = await h.relay.reply(7, incoming());
    expect(second.reply).toBeNull();
    expect(h.handleMessage).toHaveBeenCalledTimes(1);
  });

  it('el mismo message_id en OTRO negocio sí se procesa', async () => {
    const h = makeRelay(enabled());
    await h.relay.reply(7, incoming());
    await h.relay.reply(8, incoming());
    expect(h.handleMessage).toHaveBeenCalledTimes(2);
  });

  it('un reinicio resetea la sesión y responde con el saludo del bot (sin IA)', async () => {
    const h = makeRelay(enabled());
    const result = await h.relay.reply(7, incoming({ text: '/start', message_id: 'R1' }));
    expect(h.reset).toHaveBeenCalledTimes(1);
    expect(h.greeting).toHaveBeenCalledWith(7);
    expect(result.reply).toBe(GREETING);
    // Marca el día: el siguiente mensaje de hoy no vuelve a presentarse.
    expect(h.markDay).toHaveBeenCalledTimes(1);
    expect(h.handleMessage).not.toHaveBeenCalled();
  });

  it('le dice al agente si es el primer mensaje del día', async () => {
    const h = makeRelay(enabled());
    h.markDay.mockReturnValueOnce(true).mockReturnValueOnce(false);

    await h.relay.reply(7, incoming({ message_id: 'A' }));
    await h.relay.reply(7, incoming({ message_id: 'B' }));

    expect(h.handleMessage.mock.calls[0][2]).toEqual({ firstMessageOfDay: true });
    expect(h.handleMessage.mock.calls[1][2]).toEqual({ firstMessageOfDay: false });
    // El día se marca con la fecha de hoy (YYYY-MM-DD).
    expect(h.markDay.mock.calls[0][1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('pedido cerrado → aviso al número del dueño (solo dígitos)', async () => {
    const h = makeRelay(enabled({ owner_chat_id: '+57 300 999 8877' }));
    h.handleMessage.mockResolvedValue({ reply: 'Listo', orders: [order] });

    const result = await h.relay.reply(7, incoming());

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].to).toBe('573009998877');
    expect(result.notifications[0].text).toMatch(/NUEVO PEDIDO/);
  });

  it('pedido cerrado sin número de avisos → no hay notificaciones', async () => {
    const h = makeRelay(enabled({ owner_chat_id: null }));
    h.handleMessage.mockResolvedValue({ reply: 'Listo', orders: [order] });
    const result = await h.relay.reply(7, incoming());
    expect(result.notifications).toEqual([]);
  });

  it('un doble cierre del mismo pedido no se notifica dos veces', async () => {
    const h = makeRelay(enabled({ owner_chat_id: '573009998877' }));
    h.handleMessage.mockResolvedValue({ reply: 'Listo', orders: [order] });
    h.rememberOrder.mockReturnValue(false);
    const result = await h.relay.reply(7, incoming());
    expect(result.notifications).toEqual([]);
  });
});

describe('WhatsappWebRelayService — toma de control humana', () => {
  it('takeover pausa el chat en el canal whatsapp', async () => {
    const h = makeRelay(enabled());
    const result = await h.relay.takeover(7, '  573001112233@s.whatsapp.net ');
    expect(h.pause).toHaveBeenCalledWith(7, 'whatsapp', '573001112233@s.whatsapp.net');
    expect(result.paused_until).toBe('2026-10-31T05:00:00.000Z');
  });

  it('si un humano tomó el chat, el agente no responde ni llama a la IA', async () => {
    const h = makeRelay(enabled());
    h.isPaused.mockResolvedValue(true);
    await expect(h.relay.reply(7, incoming())).resolves.toEqual({
      reply: null,
      notifications: [],
    });
    expect(h.handleMessage).not.toHaveBeenCalled();
    expect(h.isPaused).toHaveBeenCalledWith(7, 'whatsapp', '573001112233@s.whatsapp.net');
  });

  it('pausado: tampoco responde a un /start', async () => {
    const h = makeRelay(enabled());
    h.isPaused.mockResolvedValue(true);
    const result = await h.relay.reply(7, incoming({ text: '/start', message_id: 'R9' }));
    expect(result.reply).toBeNull();
    expect(h.greeting).not.toHaveBeenCalled();
  });

  it('si el humano interviene MIENTRAS el agente piensa, se descarta la respuesta', async () => {
    const h = makeRelay(enabled({ owner_chat_id: '573009998877' }));
    h.isPaused.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    h.handleMessage.mockResolvedValue({ reply: 'Listo', orders: [order] });

    const result = await h.relay.reply(7, incoming());

    expect(h.handleMessage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reply: null, notifications: [] });
  });
});

describe('WhatsappWebRelayService — notas de voz', () => {
  const voice = (overrides: Record<string, string> = {}) =>
    incoming({ text: '', audio_base64: 'T2dnUw==', audio_mime_type: 'audio/ogg; codecs=opus', ...overrides });

  it('transcribe la nota de voz y la atiende como texto', async () => {
    const h = makeRelay(enabled());
    const result = await h.relay.reply(7, voice());

    expect(h.transcribeAudio).toHaveBeenCalledWith({
      companyId: 7,
      data: 'T2dnUw==',
      mime_type: 'audio/ogg; codecs=opus',
    });
    const [, turns] = h.handleMessage.mock.calls[0];
    expect(turns[turns.length - 1]).toEqual({ role: 'user', content: '¿tienes uva pasa?' });
    expect(result.reply).toBe('Claro, ¿cuánto?');
  });

  it('si no se entiende el audio, pide que lo escriba (sin llamar al vendedor)', async () => {
    const h = makeRelay(enabled());
    h.transcribeAudio.mockResolvedValue(null);
    const result = await h.relay.reply(7, voice());
    expect(result).toEqual({ reply: AUDIO_NOT_UNDERSTOOD_REPLY, notifications: [] });
    expect(h.handleMessage).not.toHaveBeenCalled();
  });

  it('con texto escrito no transcribe nada', async () => {
    const h = makeRelay(enabled());
    await h.relay.reply(7, incoming({ audio_base64: 'T2dnUw==' }));
    expect(h.transcribeAudio).not.toHaveBeenCalled();
  });

  it('sin texto ni audio no responde', async () => {
    const h = makeRelay(enabled());
    await expect(h.relay.reply(7, incoming({ text: '' }))).resolves.toEqual({
      reply: null,
      notifications: [],
    });
  });

  it('con el chat pausado no gasta IA transcribiendo', async () => {
    const h = makeRelay(enabled());
    h.isPaused.mockResolvedValue(true);
    await h.relay.reply(7, voice());
    expect(h.transcribeAudio).not.toHaveBeenCalled();
  });

  it('asistente apagado: no transcribe', async () => {
    const h = makeRelay(enabled({ enabled: false }));
    await h.relay.reply(7, voice());
    expect(h.transcribeAudio).not.toHaveBeenCalled();
  });
});

describe('WhatsappWebRelayService — agente inhabilitado desde el panel', () => {
  it('no responde ni transcribe ni llama a la IA', async () => {
    const h = makeRelay(enabled());
    h.accessEnabled.mockResolvedValue(false);
    const result = await h.relay.reply(
      7,
      incoming({ text: '', audio_base64: 'T2dnUw==', audio_mime_type: 'audio/ogg' }),
    );
    expect(result).toEqual({ reply: null, notifications: [] });
    expect(h.accessEnabled).toHaveBeenCalledWith(7);
    expect(h.transcribeAudio).not.toHaveBeenCalled();
    expect(h.handleMessage).not.toHaveBeenCalled();
  });

  it('la toma de control también queda bloqueada (403)', async () => {
    const h = makeRelay(enabled());
    h.assertEnabled.mockRejectedValue(new Error('SALES_AGENT_NOT_ENABLED'));
    await expect(h.relay.takeover(7, 'chat@s.whatsapp.net')).rejects.toThrow('SALES_AGENT_NOT_ENABLED');
    expect(h.pause).not.toHaveBeenCalled();
  });
});
