import type { ConversationGuardService } from '../conversation-guard.service';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import type { GeminiClient } from '@/modules/ai/internal/gemini-client';
import type { GeminiRoundResult } from '@/modules/ai/internal/gemini-client';
import type { ChatTurn } from '@/modules/ai/internal/gemini.types';

import {
  MAX_AUDIO_BASE64_LENGTH,
  ROUNDS_EXHAUSTED_REPLY,
  SalesAgentService,
} from '../seller-agent.service';
import type { SalesBotSettingsService } from '../sales-bot-settings.service';
import type { SellerCartService } from '../seller-cart.service';
import type { SalesAgentAccessService } from '@/modules/sales-agent-access/sales-agent-access.service';
import { emptyCart, setCartItem } from '../internal/cart';
import Big from 'big.js';
import type { SellerToolRunner, SellerToolContext } from '../internal/seller-tool-runner';

const CONTEXT: SellerToolContext = {
  companyId: 7,
  channel: 'telegram',
  chatId: '999',
  chatDisplayName: 'María',
};

const round = (overrides: Partial<GeminiRoundResult>): GeminiRoundResult => ({
  text: '',
  parts: [],
  functionCalls: [],
  ...overrides,
});

interface Harness {
  service: SalesAgentService;
  guard: {
    get: jest.Mock;
    addStrike: jest.Mock;
    resetStrikes: jest.Mock;
    mute: jest.Mock;
    unmute: jest.Mock;
  };
  streamRound: jest.Mock;
  execute: jest.Mock;
  isEnabled: jest.Mock;
  getSettings: jest.Mock;
  getCart: jest.Mock;
  dataSource: DataSource;
  recordUsage: jest.Mock;
}

const makeService = (): Harness => {
  const config = {
    model: 'gemini-flash-latest',
    temperature: 0.8,
    maxOutputTokens: 2048,
    maxToolRounds: 4,
    thinkingBudget: 128,
  };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue(config),
  } as unknown as ConfigService;

  const streamRound = jest.fn();
  const isEnabled = jest.fn().mockReturnValue(true);
  const gemini = {
    isEnabled,
    resolveModel: (m?: string) => m ?? 'gemini-flash-latest',
    streamRound,
  } as unknown as GeminiClient;

  const execute = jest.fn();
  const toolRunner = { execute } as unknown as SellerToolRunner;

  const dataSource = {
    query: jest.fn().mockResolvedValue([{ name: 'Granero La 21' }]),
  } as unknown as DataSource;

  const getSettings = jest
    .fn()
    .mockResolvedValue({ bot_name: '', personality: 'amable_profesional', stock_policy: 'inform' });
  const botSettings = { get: getSettings } as unknown as SalesBotSettingsService;

  const getCart = jest.fn().mockResolvedValue(null);
  const cart = { get: getCart } as unknown as SellerCartService;

  const recordUsage = jest.fn().mockResolvedValue(undefined);
  const access = { recordUsage } as unknown as SalesAgentAccessService;

  const guard = {
    get: jest.fn().mockResolvedValue({ strikes: 0, muted: false }),
    addStrike: jest.fn().mockResolvedValue(1),
    resetStrikes: jest.fn().mockResolvedValue(undefined),
    mute: jest.fn().mockResolvedValue(undefined),
    unmute: jest.fn().mockResolvedValue(undefined),
  };

  const service = new SalesAgentService(
    configService,
    gemini,
    toolRunner,
    dataSource,
    botSettings,
    cart,
    access,
    guard as unknown as ConversationGuardService,
  );
  return {
    service,
    guard,
    streamRound,
    execute,
    isEnabled,
    getSettings,
    getCart,
    dataSource,
    recordUsage,
  };
};

const turns: ChatTurn[] = [{ role: 'user', content: 'Hola, ¿tienes arroz?' }];

const systemText = (streamRound: jest.Mock): string => {
  const [body] = streamRound.mock.calls[0];
  return body.systemInstruction.parts[0].text as string;
};

describe('SalesAgentService.handleMessage', () => {
  it('usa razonamiento BAJO (thinkingBudget de la config) para responder rápido', async () => {
    const { service, streamRound } = makeService();
    streamRound.mockResolvedValueOnce(round({ text: 'hola' }));

    await service.handleMessage(CONTEXT, turns);

    const [body] = streamRound.mock.calls[0];
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 128 });
  });

  it('responde directo cuando el modelo no pide herramientas', async () => {
    const { service, streamRound, execute } = makeService();
    streamRound.mockResolvedValueOnce(round({ text: '¡Hola! Claro, ¿cuánto necesitas? 😊' }));

    const result = await service.handleMessage(CONTEXT, turns);

    expect(result.reply).toBe('¡Hola! Claro, ¿cuánto necesitas? 😊');
    expect(result.orders).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(streamRound).toHaveBeenCalledTimes(1);
  });

  it('ejecuta una herramienta y luego responde con el resultado', async () => {
    const { service, streamRound, execute } = makeService();
    const call = { name: 'search_products', args: { query: 'arroz' } };
    streamRound
      .mockResolvedValueOnce(round({ parts: [{ functionCall: call }], functionCalls: [call] }))
      .mockResolvedValueOnce(round({ text: 'Tenemos Arroz x libra a $ 3.000. ¿Te separo?' }));
    execute.mockResolvedValue({ response: { products: [{ name: 'Arroz x libra' }] } });

    const result = await service.handleMessage(CONTEXT, turns);

    expect(execute).toHaveBeenCalledTimes(1);
    // Las herramientas reciben el contexto + la política de stock del negocio.
    expect(execute).toHaveBeenCalledWith(call, {
      ...CONTEXT,
      stockPolicy: 'inform',
      pickupAvailable: true,
      deliveryAvailable: true,
    });
    expect(result.reply).toContain('$ 3.000');
    expect(result.orders).toEqual([]);
  });

  it('política offer_always: llega al prompt y a las herramientas', async () => {
    const { service, streamRound, execute, getSettings } = makeService();
    getSettings.mockResolvedValue({ stock_policy: 'offer_always' });
    const call = { name: 'search_products', args: { query: 'arroz' } };
    streamRound
      .mockResolvedValueOnce(round({ parts: [{ functionCall: call }], functionCalls: [call] }))
      .mockResolvedValueOnce(round({ text: 'Arroz x libra a $ 3.000' }));
    execute.mockResolvedValue({ response: { products: [] } });

    await service.handleMessage(CONTEXT, turns);

    expect(getSettings).toHaveBeenCalledWith(CONTEXT.companyId);
    expect(execute).toHaveBeenCalledWith(call, {
      ...CONTEXT,
      stockPolicy: 'offer_always',
      // Sin ajuste de entregas: los defaults (recoger + domicilio).
      pickupAvailable: true,
      deliveryAvailable: true,
    });
    const [body] = streamRound.mock.calls[0];
    expect(body.systemInstruction.parts[0].text).toMatch(/NUNCA hables de\s+existencias/);
  });

  it('entregas: "solo recoger" llega al prompt y a las herramientas (nunca pide dirección)', async () => {
    const { service, streamRound, execute, getSettings } = makeService();
    getSettings.mockResolvedValue({
      stock_policy: 'inform',
      delivery_modes: ['pickup'],
      pickup_address: 'Calle 10 # 5-20',
    });
    const call = { name: 'search_products', args: { query: 'clavo' } };
    streamRound
      .mockResolvedValueOnce(round({ parts: [{ functionCall: call }], functionCalls: [call] }))
      .mockResolvedValueOnce(round({ text: 'Listo' }));
    execute.mockResolvedValue({ response: { products: [] } });

    await service.handleMessage(CONTEXT, turns);

    expect(execute).toHaveBeenCalledWith(
      call,
      expect.objectContaining({ pickupAvailable: true, deliveryAvailable: false }),
    );
    const prompt = streamRound.mock.calls[0][0].systemInstruction.parts[0].text as string;
    expect(prompt).toContain('los pedidos SOLO se RECOGEN en Calle 10 # 5-20');
    expect(prompt).toContain('NO hace\n  envíos a domicilio');
  });

  it('estilo propio y formas de pago del negocio llegan al prompt', async () => {
    const { service, streamRound, getSettings } = makeService();
    getSettings.mockResolvedValue({
      bot_name: 'Diana',
      personality: 'amable_profesional',
      stock_policy: 'inform',
      greeting_style: 'Saluda con ¡Hola, vecino!',
      selling_style: '',
      closing_style: 'Recuerda el domicilio gratis',
      payment_methods: ['cash', 'debit_card'],
      payment_instructions: 'Datáfono solo en domicilios',
    });
    streamRound.mockResolvedValueOnce(round({ text: '¡Hola, vecino!' }));

    await service.handleMessage(CONTEXT, turns);

    const [body] = streamRound.mock.calls[0];
    const prompt = body.systemInstruction.parts[0].text as string;
    expect(prompt).toContain('- Al saludar: «Saluda con ¡Hola, vecino!»');
    expect(prompt).toContain('- Al cerrar la venta: «Recuerda el domicilio gratis»');
    expect(prompt).not.toContain('Al asesorar y vender');
    expect(prompt).toContain('ÚNICAMENTE: efectivo y tarjeta débito');
    expect(prompt).toContain('«Datáfono solo en domicilios»');
  });

  it('las categorías del catálogo llegan al prompt', async () => {
    const { service, streamRound, dataSource } = makeService();
    (dataSource.query as jest.Mock).mockImplementation(async (sql: string) =>
      /FROM categories|JOIN categories/.test(sql)
        ? [{ name: 'Especias' }, { name: 'Productos Venezolanos' }, { name: null }]
        : [{ name: 'Esencia & Grano' }],
    );
    streamRound.mockResolvedValueOnce(round({ text: 'Sí, tenemos mayonesa Mavesa' }));

    await service.handleMessage(CONTEXT, turns);

    const prompt = systemText(streamRound);
    expect(prompt).toContain('estas categorías: Especias, Productos Venezolanos.');
  });

  it('si fallan las categorías, el agente responde igual (sin el bloque)', async () => {
    const { service, streamRound, dataSource } = makeService();
    (dataSource.query as jest.Mock).mockImplementation(async (sql: string) => {
      if (/JOIN categories/.test(sql)) throw new Error('boom');
      return [{ name: 'Esencia & Grano' }];
    });
    streamRound.mockResolvedValueOnce(round({ text: 'Hola' }));

    const result = await service.handleMessage(CONTEXT, turns);

    expect(result.reply).toBe('Hola');
    expect(systemText(streamRound)).not.toContain('# Categorías de tu catálogo');
  });

  it('recoge el pedido cerrado por submit_order', async () => {
    const { service, streamRound, execute } = makeService();
    const call = { name: 'submit_order', args: { items: [] } };
    const order = {
      items: [{ name: 'Arroz x libra', quantity: 2, unit_price: 3000, line_total: 6000 }],
      total: 6000,
      channel: 'telegram',
      chat_id: '999',
    };
    streamRound
      .mockResolvedValueOnce(round({ parts: [{ functionCall: call }], functionCalls: [call] }))
      .mockResolvedValueOnce(round({ text: '¡Listo! Tu pedido quedó registrado 🙌' }));
    execute.mockResolvedValue({ order, response: { status: 'registered' } });

    const result = await service.handleMessage(CONTEXT, turns);

    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].total).toBe(6000);
    expect(result.reply).toContain('registrado');
  });

  it('recoge los avisos para el negocio (cancelación / solicitud sobre pedido tomado)', async () => {
    const { service, streamRound, execute } = makeService();
    const call = { name: 'cancel_last_order', args: {} };
    streamRound
      .mockResolvedValueOnce(round({ parts: [{ functionCall: call }], functionCalls: [call] }))
      .mockResolvedValueOnce(round({ text: 'Listo, quedó cancelado.' }));
    execute.mockResolvedValue({
      notice: '❌ EL CLIENTE CANCELÓ EL PEDIDO P-1',
      response: { status: 'cancelled' },
    });

    const result = await service.handleMessage(CONTEXT, turns);

    expect(result.notices).toEqual(['❌ EL CLIENTE CANCELÓ EL PEDIDO P-1']);
    expect(result.orders).toEqual([]);
  });

  it('reintenta una ronda con fallo de transporte y se recupera', async () => {
    const { service, streamRound, execute } = makeService();
    streamRound
      .mockResolvedValueOnce(round({ error: 'Fallo de transporte' }))
      .mockResolvedValueOnce(round({ text: '¡Hola! Claro que sí 😊' }));

    const result = await service.handleMessage(CONTEXT, turns);

    expect(streamRound).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe('¡Hola! Claro que sí 😊');
    expect(execute).not.toHaveBeenCalled();
  });

  it('ante un error del modelo responde con un mensaje cordial', async () => {
    const { service, streamRound } = makeService();
    // Falla también el reintento → se cae al mensaje cordial.
    streamRound.mockResolvedValue(round({ error: 'boom' }));

    const result = await service.handleMessage(CONTEXT, turns);

    expect(streamRound).toHaveBeenCalledTimes(2);
    expect(result.reply).toMatch(/no puedo atenderte|intenta de nuevo/i);
    expect(result.orders).toEqual([]);
  });

  it('si la IA no está configurada responde el fallback y no llama al modelo', async () => {
    const { service, streamRound, isEnabled } = makeService();
    isEnabled.mockReturnValue(false);

    const result = await service.handleMessage(CONTEXT, turns);

    expect(result.reply).toMatch(/no puedo atenderte/i);
    expect(streamRound).not.toHaveBeenCalled();
  });
});

describe('SalesAgentService — saludo y presentación', () => {
  it('primer mensaje del día: el prompt pide saludar y presentarse', async () => {
    const { service, streamRound } = makeService();
    streamRound.mockResolvedValueOnce(round({ text: '¡Buenos días!' }));

    await service.handleMessage(CONTEXT, turns, { firstMessageOfDay: true });

    expect(systemText(streamRound)).toMatch(/primer mensaje del cliente HOY/i);
    expect(systemText(streamRound)).toMatch(/PRESÉNTATE/);
  });

  it('si ya saludó hoy, el prompt prohíbe repetir la presentación', async () => {
    const { service, streamRound } = makeService();
    streamRound.mockResolvedValueOnce(round({ text: 'Claro' }));

    await service.handleMessage(CONTEXT, turns, { firstMessageOfDay: false });

    expect(systemText(streamRound)).toMatch(/Ya saludaste a este cliente hoy/);
  });

  it('sin la marca no agrega la sección de saludo (compatibilidad)', async () => {
    const { service, streamRound } = makeService();
    streamRound.mockResolvedValueOnce(round({ text: 'Claro' }));

    await service.handleMessage(CONTEXT, turns);

    expect(systemText(streamRound)).not.toMatch(/# Saludo/);
  });

  it('greeting() presenta al bot con el nombre del negocio, sin llamar a la IA', async () => {
    const { service, streamRound } = makeService();

    const text = await service.greeting(7);

    // Sin nombre configurado usa "Place"; el negocio sale de la BD.
    expect(text).toMatch(/Place/);
    expect(text).toMatch(/Granero La 21/);
    expect(text).toMatch(/Buenos días|Buenas tardes|Buenas noches/);
    expect(streamRound).not.toHaveBeenCalled();
  });

  it('greeting() usa el nombre de los ajustes del agente (igual en todo canal)', async () => {
    const { service, getSettings } = makeService();
    getSettings.mockResolvedValue({
      bot_name: 'Diana',
      personality: 'formal_corporativo',
      stock_policy: 'inform',
    });

    const text = await service.greeting(7);

    expect(getSettings).toHaveBeenCalledWith(7);
    expect(text).toMatch(/Diana/);
  });

  it('el prompt toma nombre y personalidad de los ajustes del agente', async () => {
    const { service, streamRound, getSettings } = makeService();
    getSettings.mockResolvedValue({
      bot_name: 'Diana',
      personality: 'directo_comercial',
      stock_policy: 'inform',
    });
    streamRound.mockResolvedValueOnce(round({ text: 'Claro' }));

    await service.handleMessage({ ...CONTEXT, channel: 'whatsapp' }, turns);

    expect(systemText(streamRound)).toMatch(/Diana/);
  });
});

describe('SalesAgentService.transcribeAudio', () => {
  const audio = { companyId: 7, data: 'T2dnUw==', mime_type: 'audio/ogg; codecs=opus' };

  it('manda el audio inline a Gemini y devuelve el texto transcrito', async () => {
    const { service, streamRound } = makeService();
    streamRound.mockResolvedValueOnce(round({ text: '  ¿Tienes uva pasa?  ' }));

    await expect(service.transcribeAudio(audio)).resolves.toBe('¿Tienes uva pasa?');

    const [body] = streamRound.mock.calls[0];
    expect(body.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'audio/ogg', data: 'T2dnUw==' },
    });
    expect(body.tools).toBeUndefined();
  });

  it('"[inaudible]" o texto vacío → null', async () => {
    const { service, streamRound } = makeService();
    streamRound.mockResolvedValueOnce(round({ text: '[inaudible]' }));
    await expect(service.transcribeAudio(audio)).resolves.toBeNull();
    streamRound.mockResolvedValueOnce(round({ text: '   ' }));
    await expect(service.transcribeAudio(audio)).resolves.toBeNull();
  });

  it('error de Gemini (también tras el reintento) → null', async () => {
    const { service, streamRound } = makeService();
    streamRound.mockResolvedValue(round({ error: 'boom' }));
    await expect(service.transcribeAudio(audio)).resolves.toBeNull();
  });

  it('si Gemini lanza, no revienta: null', async () => {
    const { service, streamRound } = makeService();
    streamRound.mockRejectedValue(new Error('red'));
    await expect(service.transcribeAudio(audio)).resolves.toBeNull();
  });

  it('rechaza sin llamar a la IA: sin IA, sin datos, MIME no-audio o audio enorme', async () => {
    const { service, streamRound, isEnabled } = makeService();
    await expect(
      service.transcribeAudio({ companyId: 7, data: '', mime_type: 'audio/ogg' }),
    ).resolves.toBeNull();
    await expect(
      service.transcribeAudio({ companyId: 7, data: 'eA==', mime_type: 'image/png' }),
    ).resolves.toBeNull();
    await expect(
      service.transcribeAudio({
        companyId: 7,
        data: 'a'.repeat(MAX_AUDIO_BASE64_LENGTH + 1),
        mime_type: 'audio/ogg',
      }),
    ).resolves.toBeNull();
    isEnabled.mockReturnValue(false);
    await expect(service.transcribeAudio(audio)).resolves.toBeNull();
    expect(streamRound).not.toHaveBeenCalled();
  });
});

describe('SalesAgentService — pedido en curso', () => {
  const conversation = { companyId: 7, channel: 'whatsapp-web', chatId: '57300@s.whatsapp.net' };

  it('con conversación, el prompt incluye el pedido en curso y su etapa', async () => {
    const { service, streamRound, getCart } = makeService();
    getCart.mockResolvedValue(
      setCartItem(
        emptyCart(),
        { product_id: 5, name: 'UVA PASA X LIBRA', unit_price: new Big(8000) },
        new Big(2),
      ),
    );
    streamRound.mockResolvedValueOnce(round({ text: '¿Lo recoges o te lo envío?' }));

    await service.handleMessage({ ...CONTEXT, conversation }, turns);

    expect(getCart).toHaveBeenCalledWith(conversation);
    const prompt = systemText(streamRound);
    expect(prompt).toContain('# Pedido en curso');
    expect(prompt).toContain('2 × UVA PASA X LIBRA (id 5)');
    // Recoger y domicilio (defaults): primero hay que saber cuál prefiere.
    expect(prompt).toMatch(/Falta: si es a domicilio o lo recoge/);
  });

  it('sin conversación no consulta el carrito ni agrega el bloque', async () => {
    const { service, streamRound, getCart } = makeService();
    streamRound.mockResolvedValueOnce(round({ text: 'Hola' }));
    await service.handleMessage(CONTEXT, turns);
    expect(getCart).not.toHaveBeenCalled();
    expect(systemText(streamRound)).not.toContain('# Pedido en curso');
  });

  it('las herramientas saben si se puede recoger (negocio con dirección)', async () => {
    const { service, streamRound, execute, dataSource } = makeService();
    (dataSource.query as jest.Mock).mockResolvedValue([
      { name: 'Granero La 21', address: 'Cra 10 #20-30', phone_number: null },
    ]);
    streamRound
      .mockResolvedValueOnce(round({ functionCalls: [{ name: 'close_order', args: {} }] }))
      .mockResolvedValueOnce(round({ text: 'Listo' }));
    execute.mockResolvedValue({ response: { status: 'closed' } });

    await service.handleMessage({ ...CONTEXT, companyId: 99, conversation }, turns);

    const [, toolContext] = execute.mock.calls[0];
    expect(toolContext).toMatchObject({ pickupAvailable: true, conversation });
  });

  it('solo domicilio (ajuste del dueño): no se puede recoger, aunque haya dirección', async () => {
    const { service, streamRound, execute, getSettings } = makeService();
    getSettings.mockResolvedValue({ stock_policy: 'inform', delivery_modes: ['delivery'] });
    streamRound
      .mockResolvedValueOnce(round({ functionCalls: [{ name: 'close_order', args: {} }] }))
      .mockResolvedValueOnce(round({ text: 'Listo' }));
    execute.mockResolvedValue({ response: { status: 'closed' } });

    await service.handleMessage({ ...CONTEXT, companyId: 98, conversation }, turns);

    expect(execute.mock.calls[0][1]).toMatchObject({
      pickupAvailable: false,
      deliveryAvailable: true,
    });
  });

  it('la entrega ya NO se deduce de la dirección: sin dirección y "solo recoger", nunca pide dirección', async () => {
    const { service, streamRound, getSettings, getCart } = makeService();
    getSettings.mockResolvedValue({ stock_policy: 'inform', delivery_modes: ['pickup'] });
    getCart.mockResolvedValue(
      setCartItem(
        emptyCart(),
        { product_id: 5, name: 'UVA PASA X LIBRA', unit_price: new Big(8000) },
        new Big(1),
      ),
    );
    streamRound.mockResolvedValueOnce(round({ text: '¿A nombre de quién?' }));

    await service.handleMessage({ ...CONTEXT, companyId: 98, conversation }, turns);

    const prompt = systemText(streamRound);
    expect(prompt).toMatch(/Falta: nombre de quien recibe/);
    expect(prompt).not.toMatch(/Falta:.*dirección/);
    expect(prompt).toMatch(/SOLO se RECOGEN/);
  });
});

describe('SalesAgentService — consumo de IA (suma a la cuenta)', () => {
  const usage = (total: number) => ({
    prompt_tokens: total - 10,
    output_tokens: 10,
    thoughts_tokens: 0,
    cached_tokens: 0,
    total_tokens: total,
  });

  it('registra un mensaje con la SUMA de tokens de todas sus rondas', async () => {
    const { service, streamRound, execute, recordUsage } = makeService();
    streamRound
      .mockResolvedValueOnce(
        round({
          functionCalls: [{ name: 'search_products', args: { query: 'arroz' } }],
          usage: usage(100),
        }),
      )
      .mockResolvedValueOnce(round({ text: 'Claro', usage: usage(50) }));
    execute.mockResolvedValue({ response: { families: [] } });

    await service.handleMessage(CONTEXT, turns);

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({
      companyId: 7,
      kind: 'sales_agent',
      model: 'gemini-flash-latest',
      usage: expect.objectContaining({ total_tokens: 150, output_tokens: 20 }),
      rounds: 2,
    });
  });

  it('también registra cuando la IA falla a mitad (lo consumido se cobra)', async () => {
    const { service, streamRound, recordUsage } = makeService();
    streamRound.mockResolvedValue(
      round({ error: 'boom', usage: usage(30) } as Partial<GeminiRoundResult>),
    );
    await service.handleMessage(CONTEXT, turns);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sales_agent' }));
  });

  it('una nota de voz registra su transcripción aparte (sales_agent_audio)', async () => {
    const { service, streamRound, recordUsage } = makeService();
    streamRound.mockResolvedValueOnce(round({ text: 'hola', usage: usage(40) }));
    await service.transcribeAudio({ companyId: 9, data: 'T2dnUw==', mime_type: 'audio/ogg' });
    expect(recordUsage).toHaveBeenCalledWith({
      companyId: 9,
      kind: 'sales_agent_audio',
      model: 'gemini-flash-latest',
      usage: expect.objectContaining({ total_tokens: 40 }),
      rounds: 1,
    });
  });
});

describe('SalesAgentService · filtro de mensajes fuera de tema', () => {
  const conversation = { companyId: 7, channel: 'whatsapp-web', chatId: '57300@s.whatsapp.net' };
  const ctx = { ...CONTEXT, conversation };
  const trollTurns: ChatTurn[] = [{ role: 'user', content: '¿Tienes sentimientos?' }];

  it('en silencio y el clasificador dice NO: no corre el agente y responde en silencio', async () => {
    const { service, streamRound, guard, recordUsage } = makeService();
    guard.get.mockResolvedValue({ strikes: 3, muted: true });
    streamRound.mockResolvedValueOnce(round({ text: 'NO' }));

    const result = await service.handleMessage(ctx, trollTurns);

    expect(result).toEqual({ reply: '', orders: [], silent: true });
    // Una sola llamada: el clasificador (barato), no el agente.
    expect(streamRound).toHaveBeenCalledTimes(1);
    const [body] = streamRound.mock.calls[0];
    expect(body.tools).toBeUndefined();
    expect(body.contents[0].parts[0].text).toContain('Mensaje: «¿Tienes sentimientos?»');
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'sales_agent', rounds: 1 }),
    );
    expect(guard.unmute).not.toHaveBeenCalled();
  });

  it('en silencio y el clasificador dice SÍ: sale del silencio y atiende normal', async () => {
    const { service, streamRound, guard } = makeService();
    guard.get.mockResolvedValue({ strikes: 3, muted: true });
    streamRound
      .mockResolvedValueOnce(round({ text: 'Sí' }))
      .mockResolvedValueOnce(round({ text: 'La canela la tengo a $ 12.000.' }));

    const result = await service.handleMessage(ctx, [{ role: 'user', content: '¿Tienes canela?' }]);

    expect(guard.unmute).toHaveBeenCalledWith(conversation);
    expect(result.reply).toBe('La canela la tengo a $ 12.000.');
    expect(result.silent).toBeUndefined();
  });

  it('si el clasificador falla, sigue en silencio', async () => {
    const { service, streamRound, guard } = makeService();
    guard.get.mockResolvedValue({ strikes: 3, muted: true });
    streamRound.mockResolvedValue(round({ error: 'boom' }));
    await expect(service.handleMessage(ctx, trollTurns)).resolves.toMatchObject({ silent: true });
  });

  it('un turno sin fuera de tema reinicia el conteo; uno marcado no', async () => {
    const normal = makeService();
    normal.streamRound.mockResolvedValueOnce(round({ text: 'Hola' }));
    await normal.service.handleMessage(ctx, turns);
    expect(normal.guard.resetStrikes).toHaveBeenCalledWith(conversation);

    const flagged = makeService();
    const call = { name: 'flag_off_topic', args: { reason: 'drogas' } };
    flagged.streamRound
      .mockResolvedValueOnce(round({ parts: [{ functionCall: call }], functionCalls: [call] }))
      .mockResolvedValueOnce(round({ text: 'Por aquí solo especias. ¿Te ayudo con algo?' }));
    flagged.execute.mockResolvedValue({ offTopic: true, response: { status: 'noted' } });
    await flagged.service.handleMessage(ctx, trollTurns);
    expect(flagged.guard.resetStrikes).not.toHaveBeenCalled();
  });

  it('el límite del negocio llega a las herramientas', async () => {
    const { service, streamRound, execute, getSettings } = makeService();
    getSettings.mockResolvedValue({ stock_policy: 'inform', off_topic_limit: 5 });
    const call = { name: 'flag_off_topic', args: {} };
    streamRound
      .mockResolvedValueOnce(round({ parts: [{ functionCall: call }], functionCalls: [call] }))
      .mockResolvedValueOnce(round({ text: 'ok' }));
    execute.mockResolvedValue({ offTopic: true, response: {} });
    await service.handleMessage(ctx, trollTurns);
    expect(execute).toHaveBeenCalledWith(call, expect.objectContaining({ offTopicLimit: 5 }));
  });

  it('sin conversación (sin memoria) no consulta el filtro', async () => {
    const { service, streamRound, guard } = makeService();
    streamRound.mockResolvedValueOnce(round({ text: 'Hola' }));
    await service.handleMessage(CONTEXT, turns);
    expect(guard.get).not.toHaveBeenCalled();
  });

  it('isMuted', async () => {
    const { service, guard } = makeService();
    guard.get.mockResolvedValue({ strikes: 3, muted: true });
    await expect(service.isMuted(conversation)).resolves.toBe(true);
  });
});

describe('SalesAgentService · nunca deja al cliente esperando', () => {
  const call = { name: 'search_products', args: { query: 'aromática' } };
  const toolRound = () => round({ parts: [{ functionCall: call }], functionCalls: [call] });

  it('la ÚLTIMA ronda obliga a responder con texto (functionCallingConfig NONE)', async () => {
    const { service, streamRound, execute } = makeService();
    // maxToolRounds = 4 en la config de prueba: rondas 0..3 con herramientas.
    streamRound
      .mockResolvedValueOnce(toolRound())
      .mockResolvedValueOnce(toolRound())
      .mockResolvedValueOnce(toolRound())
      .mockResolvedValueOnce(toolRound())
      .mockResolvedValueOnce(round({ text: 'Te agregué las 2 cajitas de manzanilla.' }));
    execute.mockResolvedValue({ response: { products: [] } });

    const result = await service.handleMessage(CONTEXT, turns);

    expect(result.reply).toBe('Te agregué las 2 cajitas de manzanilla.');
    const lastBody = streamRound.mock.calls[4][0];
    expect(lastBody.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    // Las herramientas siguen declaradas (el historial las usa).
    expect(lastBody.tools).toBeDefined();
    const firstBody = streamRound.mock.calls[0][0];
    expect(firstBody.toolConfig).toBeUndefined();
  });

  it('si aun así no hay texto, NO promete "dame un momento": pide confirmar', async () => {
    const { service, streamRound, execute } = makeService();
    streamRound.mockResolvedValue(toolRound());
    execute.mockResolvedValue({ response: { products: [] } });

    const result = await service.handleMessage(CONTEXT, turns);

    expect(result.reply).toBe(ROUNDS_EXHAUSTED_REPLY);
    expect(result.reply).not.toMatch(/momento|ya te confirmo/i);
  });
});
