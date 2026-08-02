import type { AuthUser } from '@/common/types/jwt-payload.type';

import {
  GenerateAiGreetingAction,
  GREETING_TTL_MS,
} from '../actions/generate-ai-greeting.action';
import type { ResolveAiActorAction } from '../actions/resolve-ai-actor.action';
import type { GeminiClient } from '../internal/gemini-client';
import type { GeminiRoundResult } from '../internal/gemini-client';

const user = { user_id: 7, type: 'owner', account: 'user', name: 'Enrique' } as unknown as AuthUser;

const actor = {
  companyId: 3,
  userId: 7,
  isAdmin: true,
  permissions: new Set<string>(),
  canViewProfit: true,
  userName: 'Enrique',
  userRole: 'dueño del negocio',
  businessName: 'Esencia & Grano',
};

const round = (overrides: Partial<GeminiRoundResult> = {}): GeminiRoundResult => ({
  text: '',
  parts: [],
  functionCalls: [],
  ...overrides,
});

const build = (
  streamRound: jest.Mock,
  { enabled = true }: { enabled?: boolean } = {},
): GenerateAiGreetingAction => {
  const resolveActor = { execute: jest.fn().mockResolvedValue(actor) } as unknown as ResolveAiActorAction;
  const geminiClient = {
    isEnabled: () => enabled,
    resolveModel: () => 'gemini-flash-lite-latest',
    streamRound,
  } as unknown as GeminiClient;

  return new GenerateAiGreetingAction(resolveActor, geminiClient);
};

describe('GenerateAiGreetingAction', () => {
  it('entrega el saludo que escribió la IA', async () => {
    const text = 'Soy Place, el asistente de Esencia & Grano: llevo tus ventas, caja e inventario al día.';
    const streamRound = jest.fn().mockResolvedValue(round({ text }));

    const greeting = await build(streamRound).execute(user, 3);

    expect(greeting).toEqual({ text, source: 'ai' });
  });

  it('no manda herramientas ni pide streaming de texto', async () => {
    const streamRound = jest.fn().mockResolvedValue(
      round({ text: 'Soy Place, el asistente de Esencia & Grano: pregúntame lo que necesites.' }),
    );

    await build(streamRound).execute(user, 3);

    const [body] = streamRound.mock.calls[0] as [{ tools?: unknown }];
    expect(body.tools).toBeUndefined();
  });

  it('cae al saludo fijo si Gemini devuelve error', async () => {
    const streamRound = jest.fn().mockResolvedValue(round({ error: 'Sin créditos' }));

    const greeting = await build(streamRound).execute(user, 3);

    expect(greeting.source).toBe('fallback');
    expect(greeting.text).toContain('Esencia & Grano');
  });

  it('cae al saludo fijo si la respuesta no nombra al negocio', async () => {
    const streamRound = jest.fn().mockResolvedValue(
      round({ text: 'Soy Place, tu asistente. Pregúntame lo que quieras del negocio.' }),
    );

    const greeting = await build(streamRound).execute(user, 3);

    expect(greeting.source).toBe('fallback');
    expect(greeting.text).toContain('Esencia & Grano');
  });

  it('cae al saludo fijo si el cliente revienta', async () => {
    const streamRound = jest.fn().mockRejectedValue(new Error('boom'));

    const greeting = await build(streamRound).execute(user, 3);

    expect(greeting.source).toBe('fallback');
  });

  it('ni siquiera llama a Google si la IA está deshabilitada', async () => {
    const streamRound = jest.fn();

    const greeting = await build(streamRound, { enabled: false }).execute(user, 3);

    expect(streamRound).not.toHaveBeenCalled();
    expect(greeting.source).toBe('fallback');
  });

  it('cachea el saludo de la IA y lo reusa dentro de su vigencia', async () => {
    const text = 'Soy Place, el asistente de Esencia & Grano: pregúntame por ventas o inventario.';
    const streamRound = jest.fn().mockResolvedValue(round({ text }));
    const action = build(streamRound);

    await action.execute(user, 3, 1_000);
    const second = await action.execute(user, 3, 1_000 + GREETING_TTL_MS - 1);

    expect(streamRound).toHaveBeenCalledTimes(1);
    expect(second.text).toBe(text);
  });

  it('vuelve a pedir uno nuevo cuando expira', async () => {
    const text = 'Soy Place, el asistente de Esencia & Grano: pregúntame por ventas o inventario.';
    const streamRound = jest.fn().mockResolvedValue(round({ text }));
    const action = build(streamRound);

    await action.execute(user, 3, 1_000);
    await action.execute(user, 3, 1_000 + GREETING_TTL_MS + 1);

    expect(streamRound).toHaveBeenCalledTimes(2);
  });

  it('NO cachea el saludo fijo: al siguiente intento vuelve a probar con la IA', async () => {
    const streamRound = jest
      .fn()
      .mockResolvedValueOnce(round({ error: 'Sin créditos' }))
      .mockResolvedValueOnce(
        round({ text: 'Soy Place, el asistente de Esencia & Grano: ya volví, pregúntame.' }),
      );
    const action = build(streamRound);

    const first = await action.execute(user, 3, 1_000);
    const second = await action.execute(user, 3, 1_100);

    expect(first.source).toBe('fallback');
    expect(second.source).toBe('ai');
  });

  it('el saludo no se cruza entre usuarios ni entre negocios', async () => {
    const streamRound = jest
      .fn()
      .mockResolvedValue(round({ text: 'Soy Place, el asistente de Esencia & Grano: pregúntame.' }));
    const action = build(streamRound);

    await action.execute(user, 3, 1_000);
    await action.execute({ ...user, user_id: 8 } as AuthUser, 3, 1_000);
    await action.execute(user, 4, 1_000);

    expect(streamRound).toHaveBeenCalledTimes(3);
  });
});
