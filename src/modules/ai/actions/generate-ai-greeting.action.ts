import { Injectable, Logger } from '@nestjs/common';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { GeminiClient } from '../internal/gemini-client';
import {
  buildFallbackGreeting,
  buildGreetingPrompt,
  describeTopics,
  sanitizeGreeting,
} from '../internal/greeting';
import { buildGeminiRequest } from '../internal/gemini-request';
import { allowedToolsFor } from '../internal/tool-catalog';
import { ResolveAiActorAction } from './resolve-ai-actor.action';

export interface AiGreeting {
  text: string;
  /** `ai` = lo escribió Place; `fallback` = el texto fijo de siempre. */
  source: 'ai' | 'fallback';
}

/**
 * Vigencia del saludo cacheado. Suficiente para que abrir y cerrar el chat diez
 * veces no cueste diez llamadas a Google, y corto para que el texto se sienta
 * vivo a lo largo del día.
 */
export const GREETING_TTL_MS = 30 * 60 * 1000;

/** Tope de entradas en memoria; es un adorno, no puede convertirse en una fuga. */
const MAX_CACHE_ENTRIES = 500;

/** Espacio de salida holgado: los modelos con "pensamiento" gastan tokens antes de escribir. */
const GREETING_MAX_OUTPUT_TOKENS = 1024;

/** Alta a propósito: se le pide que varíe la redacción en cada saludo. */
const GREETING_TEMPERATURE = 1.1;

interface CacheEntry {
  greeting: AiGreeting;
  expiresAt: number;
}

/**
 * Escribe el saludo de bienvenida del chat.
 *
 * Nunca falla hacia el usuario: si la IA está apagada, se cae, tarda o devuelve
 * algo que no cumple las reglas, se entrega el saludo fijo. La pantalla de
 * bienvenida no puede quedarse muda por un problema con Google.
 */
@Injectable()
export class GenerateAiGreetingAction {
  private readonly logger = new Logger(GenerateAiGreetingAction.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly resolveActor: ResolveAiActorAction,
    private readonly geminiClient: GeminiClient,
  ) {}

  async execute(user: AuthUser, companyId: number, now: number = Date.now()): Promise<AiGreeting> {
    const key = `${companyId}:${user.user_id}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.greeting;
    }

    const actor = await this.resolveActor.execute(user, companyId);
    const context = {
      businessName: actor.businessName,
      topics: describeTopics(allowedToolsFor(actor).map((tool) => tool.name)),
    };
    const fallback: AiGreeting = { text: buildFallbackGreeting(context), source: 'fallback' };

    if (!this.geminiClient.isEnabled()) {
      return fallback;
    }

    const greeting = await this.generate(context, fallback);
    this.remember(key, greeting, now);
    return greeting;
  }

  private async generate(
    context: { businessName: string; topics: string[] },
    fallback: AiGreeting,
  ): Promise<AiGreeting> {
    try {
      const body = buildGeminiRequest({
        turns: [{ role: 'user', content: buildGreetingPrompt(context) }],
        temperature: GREETING_TEMPERATURE,
        maxOutputTokens: GREETING_MAX_OUTPUT_TOKENS,
      });

      const result = await this.geminiClient.streamRound(body, {
        model: this.geminiClient.resolveModel(),
        // El saludo no se transmite token a token: se entrega entero.
        onText: () => undefined,
      });

      if (result.error) {
        this.logger.warn({ detail: result.error }, 'No se pudo generar el saludo; se usa el fijo');
        return fallback;
      }

      const text = sanitizeGreeting(result.text, context.businessName);
      return text ? { text, source: 'ai' } : fallback;
    } catch (error) {
      this.logger.warn({ err: error }, 'Fallo generando el saludo; se usa el fijo');
      return fallback;
    }
  }

  /** Solo se cachea lo que escribió la IA: el fijo se recalcula gratis y así se reintenta. */
  private remember(key: string, greeting: AiGreeting, now: number): void {
    if (greeting.source !== 'ai') {
      return;
    }

    for (const [entryKey, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(entryKey);
      }
    }
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }

    this.cache.set(key, { greeting, expiresAt: now + GREETING_TTL_MS });
  }
}
