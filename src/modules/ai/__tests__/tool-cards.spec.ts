import type { ConfigService } from '@nestjs/config';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import type { ResolveAiActorAction } from '../actions/resolve-ai-actor.action';
import type { AiToolExecution, RunAiToolAction } from '../actions/run-ai-tool.action';
import {
  FINAL_ROUND_PROMPT,
  StreamAiChatAction,
  type AiStreamEvent,
} from '../actions/stream-ai-chat.action';
import type { GeminiClient, GeminiRoundResult } from '../internal/gemini-client';
import { cardForToolResult } from '../internal/tool-cards';

/**
 * La vista previa de un pedido viaja al cliente como tarjeta con los datos del
 * servidor: el usuario confirma lo que de verdad se va a crear, no lo que el
 * modelo haya escrito de ello.
 */
describe('cardForToolResult', () => {
  const summary = { customer: 'MARÍA', total: 15500, lines: [{ product: 'FECULA', quantity: 2 }] };

  it('prepare_sale con confirmación pendiente → tarjeta de vista previa con el summary exacto', () => {
    expect(cardForToolResult('prepare_sale', { status: 'confirmation_required', summary })).toEqual(
      { kind: 'sale_preview', data: summary },
    );
  });

  it.each(['prepare_treasury_transfer', 'prepare_balance_correction'])(
    '%s con confirmación pendiente → tarjeta de tesorería con el summary exacto',
    (name) => {
      const treasury = { operation: 'transfer', amount: 100000 };
      expect(
        cardForToolResult(name, { status: 'confirmation_required', summary: treasury }),
      ).toEqual({ kind: 'treasury_preview', data: treasury });
    },
  );

  it('confirm_treasury_action ejecutado → tarjeta del resultado; rechazado → sin tarjeta', () => {
    const result = { operation: 'adjust', balance: 10000 };
    expect(cardForToolResult('confirm_treasury_action', { status: 'executed', result })).toEqual({
      kind: 'treasury_done',
      data: result,
    });
    expect(cardForToolResult('confirm_treasury_action', { status: 'changed', result })).toBeNull();
    expect(
      cardForToolResult('prepare_treasury_transfer', { status: 'insufficient_balance' }),
    ).toBeNull();
  });

  it('prepare_purchase con vista previa → tarjeta de compra; needs_input → sin tarjeta', () => {
    const preview = { supplier: { name: 'La Economía', document: null }, total: 490400, lines: [] };
    expect(
      cardForToolResult('prepare_purchase', { status: 'confirmation_required', summary: preview }),
    ).toEqual({ kind: 'purchase_preview', data: preview });
    expect(
      cardForToolResult('prepare_purchase', { status: 'needs_input', summary: preview }),
    ).toBeNull();
    expect(cardForToolResult('prepare_purchase', { status: 'confirmation_required' })).toBeNull();
  });

  it('confirm_purchase ejecutado → tarjeta de compra creada; rechazado → sin tarjeta', () => {
    const purchase = { purchase_id: 5, purchase_number: 'C-5', total: 1000, status: 'PENDING' };
    expect(cardForToolResult('confirm_purchase', { status: 'executed', purchase })).toEqual({
      kind: 'purchase_created',
      data: purchase,
    });
    expect(cardForToolResult('confirm_purchase', { status: 'changed', purchase })).toBeNull();
  });

  it('confirm_sale ejecutado → tarjeta del pedido creado', () => {
    const order = { ticket_number: 'PED-001', total: 15500 };
    expect(cardForToolResult('confirm_sale', { status: 'executed', order })).toEqual({
      kind: 'sale_created',
      data: order,
    });
  });

  it.each([
    ['prepare_sale', { status: 'needs_input', lines: [] }],
    ['prepare_sale', { status: 'confirmation_required' }],
    ['prepare_sale', { status: 'confirmation_required', summary: 'texto' }],
    ['confirm_sale', { status: 'changed' }],
    ['confirm_sale', { status: 'executed', order: [1] }],
    ['register_expense', { status: 'confirmation_required', summary }],
    ['list_sales', { summary }],
  ])('%s %j → sin tarjeta', (name, response) => {
    expect(cardForToolResult(name, response as Record<string, unknown>)).toBeNull();
  });
});

const usageCredits = { recordUsage: jest.fn().mockResolvedValue(undefined) };
/** Sin adjuntos en estas conversaciones: el resolver no encuentra ninguno. */
const noAttachments = { resolve: jest.fn().mockResolvedValue(new Map()) } as never;

describe('StreamAiChatAction · evento card', () => {
  const round = (over: Partial<GeminiRoundResult>): GeminiRoundResult => ({
    text: '',
    parts: [],
    functionCalls: [],
    ...over,
  });

  const run = async (execution: Partial<AiToolExecution>): Promise<AiStreamEvent[]> => {
    const rounds = [
      round({ functionCalls: [{ name: 'prepare_sale', args: {} }], parts: [{ text: '' }] }),
      round({ text: 'Revisa la vista previa.', finishReason: 'STOP' }),
    ];
    const gemini = {
      isEnabled: () => true,
      resolveModel: () => 'modelo',
      streamRound: jest.fn((_body: unknown, options: { onText: (text: string) => void }) => {
        const next = rounds.shift() as GeminiRoundResult;
        if (next.text) {
          options.onText(next.text);
        }
        return Promise.resolve(next);
      }),
    } as unknown as GeminiClient;
    const config = {
      getOrThrow: () => ({ temperature: 0, maxOutputTokens: 100, maxToolRounds: 3 }),
    } as unknown as ConfigService;
    const resolver = {
      execute: () =>
        Promise.resolve({
          companyId: 1,
          userId: 1,
          isAdmin: true,
          is_administrator: true,
          permissions: new Set<string>(),
          canViewProfit: true,
          userName: 'Kike',
          full_name: 'Kike',
          userRole: 'dueño',
          businessName: 'Tienda',
        }),
    } as unknown as ResolveAiActorAction;
    const runTool = {
      execute: () =>
        Promise.resolve({
          name: 'prepare_sale',
          label: 'Preparando pedido',
          ok: true,
          response: {},
          durationMs: 1,
          ...execution,
        }),
    } as unknown as RunAiToolAction;

    const events: AiStreamEvent[] = [];
    await new StreamAiChatAction(
      config,
      gemini,
      resolver,
      runTool,
      usageCredits as never,
      noAttachments,
    ).execute({
      user: { user_id: 1 } as AuthUser,
      companyId: 1,
      turns: [{ role: 'user', content: 'véndele a María' }],
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
    });
    return events;
  };

  it('emite la tarjeta justo después de la herramienta y antes del texto del modelo', async () => {
    const card = { kind: 'sale_preview' as const, data: { total: 15500 } };
    const events = await run({ card });
    expect(events.map((event) => event.type)).toEqual(['tool', 'tool', 'card', 'delta', 'done']);
    expect(events[2]).toEqual({ type: 'card', card });
  });

  it('sin tarjeta no emite el evento', async () => {
    const events = await run({});
    expect(events.some((event) => event.type === 'card')).toBe(false);
  });

  it('última ronda: sin herramientas y con la orden de responder (no queda vacía)', async () => {
    const bodies: Array<{ tools?: unknown; contents: Array<{ parts: Array<{ text?: string }> }> }> =
      [];
    const gemini = {
      isEnabled: () => true,
      resolveModel: () => 'modelo',
      streamRound: jest.fn((body: (typeof bodies)[number]) => {
        bodies.push(structuredClone(body));
        // Siempre pide otra herramienta: agota las rondas.
        return Promise.resolve({
          text: '',
          parts: [{ text: '' }],
          functionCalls: bodies.length <= 1 ? [{ name: 'prepare_sale', args: {} }] : [],
          finishReason: 'STOP',
        });
      }),
    } as unknown as GeminiClient;
    const config = {
      getOrThrow: () => ({ temperature: 0, maxOutputTokens: 100, maxToolRounds: 1 }),
    } as unknown as ConfigService;
    const resolver = {
      execute: () =>
        Promise.resolve({
          isAdmin: true,
          is_administrator: true,
          permissions: new Set<string>(),
          canViewProfit: true,
          userId: 1,
          businessName: 'Tienda',
          userName: 'K',
          userRole: 'dueño',
        }),
    } as unknown as ResolveAiActorAction;
    const runTool = {
      execute: () =>
        Promise.resolve({
          name: 'prepare_sale',
          label: 'x',
          ok: true,
          response: {},
          durationMs: 1,
        }),
    } as unknown as RunAiToolAction;

    await new StreamAiChatAction(
      config,
      gemini,
      resolver,
      runTool,
      usageCredits as never,
      noAttachments,
    ).execute({
      user: { user_id: 1 } as AuthUser,
      companyId: 1,
      turns: [{ role: 'user', content: 'véndele' }],
      emit: () => undefined,
      signal: new AbortController().signal,
    });

    const last = bodies[bodies.length - 1];
    expect(last.tools).toBeUndefined();
    expect(last.contents[last.contents.length - 1].parts[0].text).toBe(FINAL_ROUND_PROMPT);
    // La primera ronda NO lleva esa instrucción.
    expect(JSON.stringify(bodies[0].contents)).not.toContain(FINAL_ROUND_PROMPT);
  });
});
