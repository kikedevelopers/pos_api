import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';

import type { GeminiClient } from '@/modules/ai/internal/gemini-client';
import type { SalesAgentAccessService } from '@/modules/sales-agent-access/sales-agent-access.service';

import {
  FOLLOW_UP_MAX_OUTPUT_TOKENS,
  FOLLOW_UP_MAX_PREVIOUS_DRAFTS,
  FOLLOW_UP_THINKING_BUDGET,
  FollowUpService,
  phoneFromChatId,
} from '../follow-up.service';
import type { SalesAgentFollowUpEntity } from '../entities/sales-agent-follow-up.entity';
import type { SellerSessionStore } from '../internal/session-store';
import type { SalesBotConfigService } from '../sales-bot-config.service';
import type { SalesBotSettingsService } from '../sales-bot-settings.service';

const COMPANY = 13;

const CUSTOMER = { id: '501', name: 'JULIO PÉREZ', phone: '300 111 2233' };

const SALE_LINES = [
  {
    sale_id: '900',
    sold_at: '2026-10-20T15:00:00.000Z',
    family_id: '10',
    family_name: 'UVA PASA',
    category: 'Frutos secos',
    in_stock: true,
    last_restock: '2026-10-25T15:00:00.000Z',
  },
  {
    sale_id: '900',
    sold_at: '2026-10-20T15:00:00.000Z',
    family_id: '11',
    family_name: 'CANELA',
    category: 'Especias',
    in_stock: false,
    last_restock: null,
  },
  {
    sale_id: '880',
    sold_at: '2026-10-01T15:00:00.000Z',
    family_id: '10',
    family_name: 'UVA PASA',
    category: 'Frutos secos',
    in_stock: true,
    last_restock: '2026-10-25T15:00:00.000Z',
  },
];

const CATALOG = [
  { id: '20', name: 'ARANDANOS', category: 'Frutos secos', description: null },
  { id: '21', name: 'MANI', category: 'Frutos secos', description: 'Tostado' },
];

const MESSAGE =
  '¡Hola, Julio! 👋 Te saluda Andrea de *Esencia & Grano*.\n\nYa nos llegaron uvas pasas nuevas y unos arándanos que combinan perfecto. ¿Te apartamos unos?';

const okRound = (payload: unknown) => ({
  text: JSON.stringify(payload),
  parts: [],
  functionCalls: [],
  usage: { prompt_tokens: 10, output_tokens: 5, thoughts_tokens: 3, cached_tokens: 0, total_tokens: 18 },
});

interface Harness {
  service: FollowUpService;
  query: jest.Mock;
  streamRound: jest.Mock;
  isEnabled: jest.Mock;
  getEntity: jest.Mock;
  getSettings: jest.Mock;
  recordUsage: jest.Mock;
  markDay: jest.Mock;
  append: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  qb: Record<string, jest.Mock>;
}

const makeService = (
  options: { customer?: typeof CUSTOMER | null; lines?: typeof SALE_LINES } = {},
): Harness => {
  const customer = options.customer === undefined ? CUSTOMER : options.customer;
  const lines = options.lines ?? SALE_LINES;
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM customers')) return customer ? [customer] : [];
    if (sql.includes('FROM companies')) return [{ name: 'Esencia & Grano' }];
    if (sql.includes('WITH recent AS')) return lines;
    if (sql.includes('SELECT product_id, related')) return [{ product_id: '10', related: [{ product_id: 20, kind: 'complement' }] }];
    if (sql.includes('LEFT JOIN product_assistant_profiles prof')) return CATALOG;
    if (sql.includes('FROM products p WHERE p.id = ANY')) return [{ id: '10' }, { id: '20' }];
    if (sql.includes('FROM sales_agent_follow_ups')) {
      return [{ customer_id: '501', created_at: new Date('2026-11-01T12:00:00.000Z') }];
    }
    return [];
  });
  const dataSource = { query } as unknown as DataSource;

  const streamRound = jest.fn().mockResolvedValue(
    okRound({ message: MESSAGE, recalled_product_ids: [10], suggested_product_ids: [20] }),
  );
  const isEnabled = jest.fn().mockReturnValue(true);
  const gemini = {
    isEnabled,
    streamRound,
    resolveModel: jest.fn().mockReturnValue('gemini-flash-lite-latest'),
  } as unknown as GeminiClient;

  const getSettings = jest.fn().mockResolvedValue({
    bot_name: 'Andrea',
    personality: 'amable_profesional',
    stock_policy: 'inform',
    greeting_style: '',
  });
  const botSettings = { get: getSettings } as unknown as SalesBotSettingsService;
  const getEntity = jest.fn().mockResolvedValue({ enabled: true });
  const botConfig = { getEntity } as unknown as SalesBotConfigService;
  const recordUsage = jest.fn().mockResolvedValue(undefined);
  const access = { recordUsage } as unknown as SalesAgentAccessService;
  const markDay = jest.fn().mockResolvedValue(true);
  const append = jest.fn().mockResolvedValue([]);
  const sessions = { markDay, append } as unknown as SellerSessionStore;

  const qb: Record<string, jest.Mock> = {};
  for (const method of ['where', 'andWhere', 'orderBy']) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  const save = jest.fn(async (entity: Record<string, unknown>) => ({
    ...entity,
    id: '77',
    created_at: new Date('2026-11-03T15:00:00.000Z'),
  }));
  const update = jest.fn().mockResolvedValue(undefined);
  const repo = {
    create: jest.fn((value: unknown) => value),
    save,
    update,
    createQueryBuilder: jest.fn(() => qb),
  } as unknown as Repository<SalesAgentFollowUpEntity>;

  const configService = {
    getOrThrow: jest.fn().mockReturnValue({ model: '' }),
  } as unknown as ConfigService;

  const service = new FollowUpService(
    configService,
    dataSource,
    gemini,
    botSettings,
    botConfig,
    access,
    sessions,
    repo,
  );
  return { service, query, streamRound, isEnabled, getEntity, getSettings, recordUsage, markDay, append, save, update, qb };
};

const promptOf = (call: unknown[]): string =>
  (call[0] as { contents: Array<{ parts: Array<{ text: string }> }> }).contents[0].parts
    .map((part) => part.text)
    .join('\n');

describe('FollowUpService.availability', () => {
  it('sin IA en el servidor: no disponible', async () => {
    const h = makeService();
    h.isEnabled.mockReturnValue(false);
    await expect(h.service.availability(COMPANY)).resolves.toEqual({
      enabled: false,
      reason: 'agent_not_ready',
    });
  });

  it.each([null, { enabled: false }])('WhatsApp del agente apagado (%p): no disponible', async (config) => {
    const h = makeService();
    h.getEntity.mockResolvedValue(config);
    await expect(h.service.availability(COMPANY)).resolves.toEqual({
      enabled: false,
      reason: 'whatsapp_disabled',
    });
    expect(h.getEntity).toHaveBeenCalledWith(COMPANY, 'whatsapp');
  });

  it('IA lista y WhatsApp activo: disponible', async () => {
    const h = makeService();
    await expect(h.service.availability(COMPANY)).resolves.toEqual({ enabled: true, reason: null });
  });
});

describe('FollowUpService.draft', () => {
  it('redacta con las últimas ventas y el catálogo, y devuelve qué productos usó', async () => {
    const h = makeService();
    const result = await h.service.draft(COMPANY, 501);

    expect(result).toEqual({
      message: MESSAGE,
      customer: { id: 501, name: 'JULIO PÉREZ', phone: '3001112233' },
      recalled: [{ id: 10, name: 'Uva pasa' }],
      suggested: [{ id: 20, name: 'Arandanos' }],
      analyzed_sales: 2,
      is_fallback: false,
    });

    const prompt = promptOf(h.streamRound.mock.calls[0]);
    expect(prompt).toContain('id 10 · "Uva pasa"');
    expect(prompt).toContain('en 2 de sus últimas compras');
    expect(prompt).toContain('ENTRÓ MERCANCÍA NUEVA');
    expect(prompt).toContain('HOY SIN EXISTENCIAS');
    expect(prompt).toContain('COMPLEMENTA a: Uva pasa');
    expect(prompt).toContain('Eres Andrea');
  });

  it('pide salida JSON estructurada con razonamiento medio y temperatura alta', async () => {
    const h = makeService();
    await h.service.draft(COMPANY, 501);
    const [body, opts] = h.streamRound.mock.calls[0];
    expect(body.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: FOLLOW_UP_THINKING_BUDGET },
      maxOutputTokens: FOLLOW_UP_MAX_OUTPUT_TOKENS,
      temperature: 1,
    });
    expect(body.generationConfig.responseSchema.required).toEqual([
      'message',
      'recalled_product_ids',
      'suggested_product_ids',
    ]);
    expect(opts.model).toBe('gemini-flash-lite-latest');
  });

  it('analiza como máximo 3 ventas, solo SALE no eliminadas del cliente y del negocio', async () => {
    const h = makeService();
    await h.service.draft(COMPANY, 501);
    const call = h.query.mock.calls.find(([sql]) => String(sql).includes('WITH recent AS'));
    expect(call?.[0]).toContain("si.ticket_type = 'SALE'");
    expect(call?.[0]).toContain('si.is_deleted = false');
    expect(call?.[1]).toEqual(['13', '501', 3]);
  });

  it('el catálogo excluye lo ya comprado y solo trae existencias (política informar)', async () => {
    const h = makeService();
    await h.service.draft(COMPANY, 501);
    const call = h.query.mock.calls.find(([sql]) => String(sql).includes('LEFT JOIN product_assistant_profiles prof'));
    expect(call?.[0]).toContain('AND p.stock > 0');
    expect(call?.[0]).toContain('p.parent_id IS NULL');
    expect(call?.[1].slice(0, 4)).toEqual(['13', ['Frutos secos', 'Especias'], [20], [10, 11]]);
  });

  it('política "ofrecer siempre": sin filtro de existencias ni datos de stock al modelo', async () => {
    const h = makeService();
    h.getSettings.mockResolvedValue({ bot_name: '', personality: 'directo_comercial', stock_policy: 'offer_always' });
    await h.service.draft(COMPANY, 501);
    const call = h.query.mock.calls.find(([sql]) => String(sql).includes('LEFT JOIN product_assistant_profiles prof'));
    expect(call?.[0]).not.toContain('AND p.stock > 0');
    const prompt = promptOf(h.streamRound.mock.calls[0]);
    expect(prompt).not.toContain('SIN EXISTENCIAS');
    expect(prompt).toContain('Eres Place');
  });

  it('si el modelo inventa un producto, pide otro con la razón exacta', async () => {
    const h = makeService();
    h.streamRound
      .mockResolvedValueOnce(okRound({ message: MESSAGE, recalled_product_ids: [], suggested_product_ids: [999] }))
      .mockResolvedValueOnce(okRound({ message: MESSAGE, recalled_product_ids: [], suggested_product_ids: [21] }));

    const result = await h.service.draft(COMPANY, 501);

    expect(result.suggested).toEqual([{ id: 21, name: 'Mani' }]);
    expect(result.is_fallback).toBe(false);
    const retryPrompt = promptOf(h.streamRound.mock.calls[1]);
    expect(retryPrompt).toContain('fue rechazado');
    expect(retryPrompt).toContain('ids 999');
    expect(h.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ rounds: 2, kind: 'sales_agent' }));
  });

  it('si falla dos veces, usa un saludo de respaldo SIN productos', async () => {
    const h = makeService();
    h.streamRound.mockResolvedValue(
      okRound({ message: MESSAGE, recalled_product_ids: [21], suggested_product_ids: [] }),
    );
    const result = await h.service.draft(COMPANY, 501);
    expect(result.is_fallback).toBe(true);
    expect(result.recalled).toEqual([]);
    expect(result.suggested).toEqual([]);
    expect(result.message).toContain('Julio');
    expect(result.message).toContain('*Esencia & Grano*');
    expect(h.streamRound).toHaveBeenCalledTimes(2);
  });

  it('fallo de transporte en ambos intentos: respaldo, y el consumo igual se registra', async () => {
    const h = makeService();
    h.streamRound.mockResolvedValue({ text: '', parts: [], functionCalls: [], error: 'timeout' });
    const result = await h.service.draft(COMPANY, 501);
    expect(result.is_fallback).toBe(true);
    expect(h.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ rounds: 2 }));
  });

  it('pasa solo los últimos borradores descartados', async () => {
    const h = makeService();
    const previous = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis'].map((w) => `Borrador ${w}`);
    await h.service.draft(COMPANY, 501, previous);
    const prompt = promptOf(h.streamRound.mock.calls[0]);
    expect(prompt).not.toContain('Borrador uno');
    expect(prompt).not.toContain('Borrador dos');
    for (const kept of previous.slice(-FOLLOW_UP_MAX_PREVIOUS_DRAFTS)) {
      expect(prompt).toContain(kept);
    }
  });

  it('cliente sin compras: igual saluda (sin ventas que analizar)', async () => {
    const h = makeService({ lines: [] });
    h.streamRound.mockResolvedValue(okRound({ message: MESSAGE, recalled_product_ids: [], suggested_product_ids: [20] }));
    const result = await h.service.draft(COMPANY, 501);
    expect(result.analyzed_sales).toBe(0);
    expect(promptOf(h.streamRound.mock.calls[0])).toContain('no hay compras registradas');
  });

  it('sin IA: 400 AGENT_NOT_READY sin consultar nada', async () => {
    const h = makeService();
    h.isEnabled.mockReturnValue(false);
    await expect(h.service.draft(COMPANY, 501)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('cliente de otro negocio o archivado: 404', async () => {
    const h = makeService({ customer: null });
    await expect(h.service.draft(COMPANY, 501)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.streamRound).not.toHaveBeenCalled();
  });

  it.each([null, '', '12 34'])('cliente sin teléfono válido (%p): 400 CUSTOMER_WITHOUT_PHONE', async (phone) => {
    const h = makeService({ customer: { ...CUSTOMER, phone: phone as string } });
    await expect(h.service.draft(COMPANY, 501)).rejects.toMatchObject({
      response: { code: 'CUSTOMER_WITHOUT_PHONE' },
    });
    expect(h.streamRound).not.toHaveBeenCalled();
  });
});

describe('FollowUpService.record', () => {
  const input = {
    customer_id: 501,
    message: `  ${MESSAGE}  `,
    chat_id: '573001112233@s.whatsapp.net',
    phone: '+57 300 111 2233',
    recalled_product_ids: [10],
    suggested_product_ids: [20, 99999],
  };

  it('guarda el envío con quién lo hizo y solo productos accesibles', async () => {
    const h = makeService();
    const view = await h.service.record(COMPANY, { user_id: 4, name: 'Enrique', lastname: 'Pacheco' }, input);
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: '13',
        customer_id: '501',
        chat_id: '573001112233@s.whatsapp.net',
        phone: '573001112233',
        message: MESSAGE,
        recalled_product_ids: ['10'],
        suggested_product_ids: ['20'],
        sent_by_user_id: '4',
        sent_by_name: 'Enrique Pacheco',
        context_attached_at: null,
      }),
    );
    expect(view).toEqual({
      id: 77,
      customer_id: 501,
      message: MESSAGE,
      created_at: '2026-11-03T15:00:00.000Z',
    });
  });

  it('sin productos no consulta el catálogo', async () => {
    const h = makeService();
    await h.service.record(COMPANY, { user_id: 4 }, { ...input, recalled_product_ids: [], suggested_product_ids: undefined });
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes('p.id = ANY'))).toBe(false);
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ sent_by_name: null }));
  });

  it.each([
    ['mensaje vacío', { message: '   ' }],
    ['mensaje enorme', { message: 'a'.repeat(901) }],
    ['número corto', { phone: '123' }],
    ['chat vacío', { chat_id: '  ' }],
  ])('rechaza %s (400)', async (_label, patch) => {
    const h = makeService();
    await expect(h.service.record(COMPANY, { user_id: 4 }, { ...input, ...patch })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.save).not.toHaveBeenCalled();
  });

  it('cliente inexistente: 404', async () => {
    const h = makeService({ customer: null });
    await expect(h.service.record(COMPANY, { user_id: 4 }, input)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('FollowUpService.attachPendingContext', () => {
  const key = { companyId: COMPANY, channel: 'whatsapp-web', chatId: '1666@lid' };

  it('sin seguimiento pendiente: no toca la conversación', async () => {
    const h = makeService();
    await expect(h.service.attachPendingContext(key, { chatId: '1666@lid', phone: '573001112233' })).resolves.toBe(false);
    expect(h.append).not.toHaveBeenCalled();
    expect(h.qb.andWhere).toHaveBeenCalledWith('(f.chat_id = :chatId OR f.phone = :phone)', {
      chatId: '1666@lid',
      phone: '573001112233',
    });
  });

  it('inyecta el MÁS RECIENTE como mensaje del agente, marca su día y cierra todos los pendientes', async () => {
    const h = makeService();
    h.qb.getMany.mockResolvedValue([
      { id: '8', message: 'Seguimiento nuevo', created_at: new Date('2026-11-03T14:00:00.000Z') },
      { id: '5', message: 'Seguimiento viejo', created_at: new Date('2026-11-01T14:00:00.000Z') },
    ]);
    await expect(h.service.attachPendingContext(key, { chatId: '1666@lid', phone: '573001112233' })).resolves.toBe(true);
    expect(h.markDay).toHaveBeenCalledWith(key, '2026-11-03');
    expect(h.append).toHaveBeenCalledWith(key, { role: 'assistant', content: 'Seguimiento nuevo' });
    expect(h.update).toHaveBeenCalledWith(['8', '5'], { context_attached_at: expect.any(Date) });
  });

  it('chat @lid sin número: busca solo por chat', async () => {
    const h = makeService();
    await h.service.attachPendingContext(key, { chatId: '1666@lid' });
    expect(h.qb.andWhere).toHaveBeenCalledWith('f.chat_id = :chatId', { chatId: '1666@lid' });
  });

  it('chat de número: deduce el número del JID', async () => {
    const h = makeService();
    await h.service.attachPendingContext(key, { chatId: '573001112233@s.whatsapp.net' });
    expect(h.qb.andWhere).toHaveBeenCalledWith('(f.chat_id = :chatId OR f.phone = :phone)', {
      chatId: '573001112233@s.whatsapp.net',
      phone: '573001112233',
    });
  });

  it('nunca lanza: ante un error de BD, el agente sigue sin contexto', async () => {
    const h = makeService();
    h.qb.getMany.mockRejectedValue(new Error('db down'));
    await expect(h.service.attachPendingContext(key, { chatId: '1666@lid' })).resolves.toBe(false);
  });
});

describe('FollowUpService.lastByCustomer', () => {
  it('devuelve la fecha del último seguimiento por cliente', async () => {
    const h = makeService();
    await expect(h.service.lastByCustomer(COMPANY)).resolves.toEqual([
      { customer_id: 501, created_at: '2026-11-01T12:00:00.000Z' },
    ]);
  });
});

describe('phoneFromChatId', () => {
  it.each([
    ['573001112233@s.whatsapp.net', '573001112233'],
    ['573001112233:12@s.whatsapp.net', '573001112233'],
    ['1666@lid', ''],
    ['grupo@g.us', ''],
  ])('%s → %p', (jid, expected) => {
    expect(phoneFromChatId(jid)).toBe(expected);
  });
});
