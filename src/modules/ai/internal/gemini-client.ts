import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AiConfig } from '@/config/ai.config';

import {
  describeHttpFailure,
  describeTransportFailure,
  extractApiErrorDetail,
  isRetriableHttpFailure,
} from './gemini-errors';
import { buildStreamUrl } from './gemini-request';
import { parseGeminiEvent, splitSseEvents } from './gemini-sse';
import type { GeminiFunctionCall, GeminiPart, GeminiRequestBody } from './gemini.types';

/** Resultado de UNA ronda de generación (hasta que el modelo calla o pide tools). */
export interface GeminiRoundResult {
  /** Texto visible emitido en la ronda (ya entregado también por `onText`). */
  text: string;
  /** Partes crudas del modelo, para devolverlas en la siguiente ronda. */
  parts: GeminiPart[];
  functionCalls: GeminiFunctionCall[];
  finishReason?: string;
  blockReason?: string;
  /** Mensaje de error YA traducido al español, listo para el usuario. */
  error?: string;
}

/** Pausa antes del único reintento de un fallo transitorio. */
const RETRY_DELAY_MS = 600;

export interface GeminiRoundOptions {
  model: string;
  /** Se llama con cada pedacito de texto en cuanto llega. */
  onText: (text: string) => void;
  /** Aborta si el cliente cierra la conexión. */
  signal?: AbortSignal;
}

/**
 * Cliente HTTP de Gemini. Es la ÚNICA pieza impura del módulo: hace el fetch y
 * va empujando el texto al callback. Todo el parseo vive en `gemini-sse.ts`
 * (puro y testeado).
 */
@Injectable()
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);

  constructor(private readonly configService: ConfigService) {}

  private get config(): AiConfig {
    return this.configService.getOrThrow<AiConfig>('ai');
  }

  /** `false` cuando el servidor no tiene llave configurada. */
  isEnabled(): boolean {
    return this.config.apiKey.length > 0;
  }

  resolveModel(requested?: string): string {
    const { defaultModel, allowedModels } = this.config;
    const model = requested?.trim();
    if (!model) {
      return defaultModel;
    }
    return allowedModels.includes(model) ? model : defaultModel;
  }

  isModelAllowed(model: string): boolean {
    return this.config.allowedModels.includes(model.trim());
  }

  get allowedModels(): string[] {
    return [...this.config.allowedModels];
  }

  async streamRound(
    body: GeminiRequestBody,
    { model, onText, signal }: GeminiRoundOptions,
  ): Promise<GeminiRoundResult> {
    const config = this.config;
    const url = buildStreamUrl(config.baseUrl, model, config.apiKey);

    const controller = new AbortController();
    const abortOuter = (): void => controller.abort();
    signal?.addEventListener('abort', abortOuter, { once: true });
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    const accumulated: GeminiRoundResult = { text: '', parts: [], functionCalls: [] };

    try {
      // Un fallo reintentable (5xx o el 404 fantasma de Google) se reintenta UNA
      // vez con una pausa corta. Es seguro porque todavía no se emitió texto:
      // la respuesta o llega buena, o llega el error de verdad con su mensaje.
      let response: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (signal?.aborted) {
          return accumulated;
        }

        const current = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (current.ok) {
          response = current;
          break;
        }

        const rawBody = await current.text().catch(() => '');
        const retriable = attempt === 0 && isRetriableHttpFailure(current.status, rawBody);
        this.logger[retriable ? 'warn' : 'error'](
          {
            status: current.status,
            detail: extractApiErrorDetail(rawBody),
            model,
            attempt: attempt + 1,
            willRetry: retriable,
          },
          'Gemini respondió con error',
        );

        if (!retriable) {
          return { ...accumulated, error: describeHttpFailure(current.status, rawBody) };
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }

      if (!response?.body) {
        return { ...accumulated, error: describeHttpFailure(502) };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const { data, rest } = splitSseEvents(buffer);
        buffer = rest;

        for (const payload of data) {
          const event = parseGeminiEvent(payload);
          if (event.error) {
            accumulated.error = event.error;
            continue;
          }
          if (event.blockReason) {
            accumulated.blockReason = event.blockReason;
          }
          if (event.finishReason) {
            accumulated.finishReason = event.finishReason;
          }
          if (event.parts.length > 0) {
            accumulated.parts.push(...event.parts);
          }
          if (event.functionCalls.length > 0) {
            accumulated.functionCalls.push(...event.functionCalls);
          }
          if (event.text.length > 0) {
            accumulated.text += event.text;
            onText(event.text);
          }
        }
      }

      // Cola: lo que quedó sin separador final (Google no siempre lo manda).
      const tail = splitSseEvents(`${buffer}\n\n`);
      for (const payload of tail.data) {
        const event = parseGeminiEvent(payload);
        if (event.error) {
          accumulated.error = event.error;
          continue;
        }
        if (event.blockReason) {
          accumulated.blockReason = event.blockReason;
        }
        if (event.finishReason) {
          accumulated.finishReason = event.finishReason;
        }
        if (event.parts.length > 0) {
          accumulated.parts.push(...event.parts);
        }
        if (event.functionCalls.length > 0) {
          accumulated.functionCalls.push(...event.functionCalls);
        }
        if (event.text.length > 0) {
          accumulated.text += event.text;
          onText(event.text);
        }
      }

      return accumulated;
    } catch (error) {
      // Aborto pedido por el cliente: no es un error que haya que reportar.
      if (signal?.aborted) {
        return accumulated;
      }
      this.logger.error({ err: error, model }, 'Fallo de transporte hablando con Gemini');
      return { ...accumulated, error: describeTransportFailure(error) };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortOuter);
    }
  }
}
