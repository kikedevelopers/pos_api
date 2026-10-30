import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import type { GeminiClient } from '@/modules/ai/internal/gemini-client';
import type { GeminiRoundResult } from '@/modules/ai/internal/gemini-client';
import type { ChatTurn } from '@/modules/ai/internal/gemini.types';

import { MAX_AUDIO_BASE64_LENGTH, SalesAgentService } from '../seller-agent.service';
import type { SalesBotSettingsService } from '../sales-bot-settings.service';
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
  streamRound: jest.Mock;
  execute: jest.Mock;
  isEnabled: jest.Mock;
  getSettings: jest.Mock;
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

  const service = new SalesAgentService(
    configService,
    gemini,
    toolRunner,
    dataSource,
    botSettings,
  );
  return { service, streamRound, execute, isEnabled, getSettings };
};

const turns: ChatTurn[] = [{ role: 'user', content: 'Hola, ¿tienes arroz?' }];

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
    expect(execute).toHaveBeenCalledWith(call, { ...CONTEXT, stockPolicy: 'inform' });
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
    expect(execute).toHaveBeenCalledWith(call, { ...CONTEXT, stockPolicy: 'offer_always' });
    const [body] = streamRound.mock.calls[0];
    expect(body.systemInstruction.parts[0].text).toMatch(/NUNCA hables de\s+existencias/);
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
  const systemText = (streamRound: jest.Mock): string => {
    const [body] = streamRound.mock.calls[0];
    return body.systemInstruction.parts[0].text as string;
  };

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
  const audio = { data: 'T2dnUw==', mime_type: 'audio/ogg; codecs=opus' };

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
    streamRound.mockResolvedValue(round({ error: 'boom' } as Partial<GeminiRoundResult>));
    await expect(service.transcribeAudio(audio)).resolves.toBeNull();
  });

  it('si Gemini lanza, no revienta: null', async () => {
    const { service, streamRound } = makeService();
    streamRound.mockRejectedValue(new Error('red'));
    await expect(service.transcribeAudio(audio)).resolves.toBeNull();
  });

  it('rechaza sin llamar a la IA: sin IA, sin datos, MIME no-audio o audio enorme', async () => {
    const { service, streamRound, isEnabled } = makeService();
    await expect(service.transcribeAudio({ data: '', mime_type: 'audio/ogg' })).resolves.toBeNull();
    await expect(service.transcribeAudio({ data: 'eA==', mime_type: 'image/png' })).resolves.toBeNull();
    await expect(
      service.transcribeAudio({ data: 'a'.repeat(MAX_AUDIO_BASE64_LENGTH + 1), mime_type: 'audio/ogg' }),
    ).resolves.toBeNull();
    isEnabled.mockReturnValue(false);
    await expect(service.transcribeAudio(audio)).resolves.toBeNull();
    expect(streamRound).not.toHaveBeenCalled();
  });
});
