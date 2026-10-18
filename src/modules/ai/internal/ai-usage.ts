import type { GeminiUsage } from './gemini.types';

/**
 * Consumo de Place, puro. Una pregunta puede tomar varias rondas (el modelo
 * pide herramientas y se le vuelve a preguntar): cada ronda se cobra completa,
 * así que el consumo de la pregunta es la SUMA de sus rondas.
 */

export const EMPTY_USAGE: GeminiUsage = {
  prompt_tokens: 0,
  output_tokens: 0,
  thoughts_tokens: 0,
  cached_tokens: 0,
  total_tokens: 0,
};

export const addUsage = (a: GeminiUsage, b: GeminiUsage | undefined): GeminiUsage =>
  b
    ? {
        prompt_tokens: a.prompt_tokens + b.prompt_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
        thoughts_tokens: a.thoughts_tokens + b.thoughts_tokens,
        cached_tokens: a.cached_tokens + b.cached_tokens,
        total_tokens: a.total_tokens + b.total_tokens,
      }
    : a;

/** Créditos del día de una cuenta. `remaining` nunca es negativo. */
export interface AiCreditsStatus {
  daily_limit: number;
  used_today: number;
  remaining: number;
}

export const toCreditsStatus = (daily_limit: number, used_today: number): AiCreditsStatus => ({
  daily_limit,
  used_today,
  remaining: Math.max(0, daily_limit - used_today),
});
