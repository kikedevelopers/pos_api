import { addUsage, EMPTY_USAGE, toCreditsStatus } from '../internal/ai-usage';
import { parseGeminiEvent, parseUsage } from '../internal/gemini-sse';

/** Lo que cobra Gemini: el consumo debe leerse y sumarse sin perder un token. */
describe('parseUsage (usageMetadata de Gemini)', () => {
  it('lee entrada, salida, razonamiento, caché y total', () => {
    expect(
      parseUsage({
        promptTokenCount: 1200,
        candidatesTokenCount: 80,
        thoughtsTokenCount: 40,
        cachedContentTokenCount: 600,
        totalTokenCount: 1320,
      }),
    ).toEqual({
      prompt_tokens: 1200,
      output_tokens: 80,
      thoughts_tokens: 40,
      cached_tokens: 600,
      total_tokens: 1320,
    });
  });

  it('campos ausentes o basura cuentan 0; sin total, lo suma', () => {
    expect(
      parseUsage({ promptTokenCount: 3, candidatesTokenCount: 'x', thoughtsTokenCount: -5 }),
    ).toEqual({
      prompt_tokens: 3,
      output_tokens: 0,
      thoughts_tokens: 0,
      cached_tokens: 0,
      total_tokens: 3,
    });
    expect(parseUsage(undefined)).toBeUndefined();
    expect(parseUsage([1])).toBeUndefined();
  });

  it('la trama del stream trae el consumo (como la respuesta real de Gemini)', () => {
    const raw = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hola' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 14, totalTokenCount: 17 },
    });
    expect(parseGeminiEvent(raw).usage).toMatchObject({
      prompt_tokens: 3,
      output_tokens: 14,
      total_tokens: 17,
    });
    // Una trama con solo consumo (sin candidato) también lo trae.
    expect(
      parseGeminiEvent(JSON.stringify({ usageMetadata: { promptTokenCount: 9 } })).usage
        ?.prompt_tokens,
    ).toBe(9);
  });
});

describe('addUsage / toCreditsStatus', () => {
  it('suma las rondas de una pregunta', () => {
    const round = {
      prompt_tokens: 100,
      output_tokens: 10,
      thoughts_tokens: 5,
      cached_tokens: 0,
      total_tokens: 115,
    };
    expect(addUsage(addUsage(EMPTY_USAGE, round), round)).toEqual({
      prompt_tokens: 200,
      output_tokens: 20,
      thoughts_tokens: 10,
      cached_tokens: 0,
      total_tokens: 230,
    });
    expect(addUsage(round, undefined)).toBe(round);
  });

  it('remaining nunca es negativo (límite bajado por debajo de lo usado)', () => {
    expect(toCreditsStatus(5, 2)).toEqual({ daily_limit: 5, used_today: 2, remaining: 3 });
    expect(toCreditsStatus(1, 4)).toEqual({ daily_limit: 1, used_today: 4, remaining: 0 });
  });
});
