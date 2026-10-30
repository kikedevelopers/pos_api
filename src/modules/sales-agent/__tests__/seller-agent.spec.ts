import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import type { GeminiClient } from '@/modules/ai/internal/gemini-client';
import type { GeminiRoundResult } from '@/modules/ai/internal/gemini-client';
import type { ChatTurn } from '@/modules/ai/internal/gemini.types';

import { SalesAgentService } from '../seller-agent.service';
import type { SalesBotConfigService } from '../sales-bot-config.service';
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

  const botConfig = {
    getPersona: jest
      .fn()
      .mockResolvedValue({ botName: '', personality: 'amable_profesional' }),
  } as unknown as SalesBotConfigService;

  const service = new SalesAgentService(configService, gemini, toolRunner, dataSource, botConfig);
  return { service, streamRound, execute, isEnabled };
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
    expect(execute).toHaveBeenCalledWith(call, CONTEXT);
    expect(result.reply).toContain('$ 3.000');
    expect(result.orders).toEqual([]);
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
