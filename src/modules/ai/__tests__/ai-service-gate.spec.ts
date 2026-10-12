import { ForbiddenException } from '@nestjs/common';

import { AiService } from '../ai.service';

// ---------------------------------------------------------------------------
// Gate de acceso por cuenta: Place solo está disponible si el servidor tiene
// llave de Gemini Y la company tiene `ai_enabled = true`. Apagado por defecto.
// ---------------------------------------------------------------------------

const USER = { user_id: 1, type: 'owner' } as never;
const ACTOR = { companyId: 7, isAdmin: true, permissions: new Set<string>(), userId: 1 };

function build(opts: { geminiEnabled: boolean; companyAiEnabled: boolean | null }) {
  const streamExecute = jest.fn().mockResolvedValue(undefined);
  const greetingExecute = jest.fn().mockResolvedValue({ text: 'hola', source: 'ai' });
  const resolveExecute = jest.fn().mockResolvedValue(ACTOR);

  const geminiClient = {
    isEnabled: jest.fn().mockReturnValue(opts.geminiEnabled),
    resolveModel: jest.fn().mockReturnValue('gemini-flash-lite-latest'),
    allowedModels: ['gemini-flash-lite-latest'],
  };

  // company === null simula "no existe" → sin acceso.
  const company =
    opts.companyAiEnabled === null ? null : { id: '7', ai_enabled: opts.companyAiEnabled };
  const companiesRepo = { findOne: jest.fn().mockResolvedValue(company) };

  const service = new AiService(
    { execute: streamExecute } as never,
    { execute: greetingExecute } as never,
    { execute: resolveExecute } as never,
    geminiClient as never,
    companiesRepo as never,
  );

  return { service, streamExecute, greetingExecute };
}

describe('AiService · gate de acceso por cuenta', () => {
  it('status.enabled = false cuando la cuenta NO tiene acceso (aunque Gemini esté ok)', async () => {
    const { service } = build({ geminiEnabled: true, companyAiEnabled: false });
    const status = await service.status(USER, 7);
    expect(status.enabled).toBe(false);
  });

  it('status.enabled = true cuando Gemini está ok Y la cuenta tiene acceso', async () => {
    const { service } = build({ geminiEnabled: true, companyAiEnabled: true });
    const status = await service.status(USER, 7);
    expect(status.enabled).toBe(true);
  });

  it('status.enabled = false si falta la llave de Gemini (aunque la cuenta esté encendida)', async () => {
    const { service } = build({ geminiEnabled: false, companyAiEnabled: true });
    const status = await service.status(USER, 7);
    expect(status.enabled).toBe(false);
  });

  it('status.enabled = false si la company no existe', async () => {
    const { service } = build({ geminiEnabled: true, companyAiEnabled: null });
    const status = await service.status(USER, 7);
    expect(status.enabled).toBe(false);
  });

  it('chat lanza 403 (AI_NOT_ENABLED) y NO llama al stream cuando la cuenta está apagada', async () => {
    const { service, streamExecute } = build({ geminiEnabled: true, companyAiEnabled: false });
    expect.assertions(3);
    try {
      await service.chat({ companyId: 7 } as never);
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        payload: { code: 'AI_NOT_ENABLED' },
      });
    }
    expect(streamExecute).not.toHaveBeenCalled();
  });

  it('chat llama al stream cuando la cuenta tiene acceso', async () => {
    const { service, streamExecute } = build({ geminiEnabled: true, companyAiEnabled: true });
    await service.chat({ companyId: 7 } as never);
    expect(streamExecute).toHaveBeenCalledTimes(1);
  });

  it('greeting lanza 403 cuando la cuenta está apagada (no gasta Gemini)', async () => {
    const { service, greetingExecute } = build({ geminiEnabled: true, companyAiEnabled: false });
    await expect(service.greeting(USER, 7)).rejects.toBeInstanceOf(ForbiddenException);
    expect(greetingExecute).not.toHaveBeenCalled();
  });

  it('greeting responde cuando la cuenta tiene acceso', async () => {
    const { service, greetingExecute } = build({ geminiEnabled: true, companyAiEnabled: true });
    const greeting = await service.greeting(USER, 7);
    expect(greeting).toEqual({ text: 'hola', source: 'ai' });
    expect(greetingExecute).toHaveBeenCalledTimes(1);
  });
});
