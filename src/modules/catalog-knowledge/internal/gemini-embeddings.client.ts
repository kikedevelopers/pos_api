import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AiConfig } from '@/config/ai.config';

import { normalizeVector } from './profile';

/** Modelo de embeddings de Gemini (estable). */
export const EMBEDDING_MODEL = 'gemini-embedding-001';

/** Dimensiones pedidas (reducidas desde 3072; hay que normalizarlas). */
export const EMBEDDING_DIMENSIONS = 768;

/** Textos máximos por llamada a `batchEmbedContents`. */
export const EMBEDDING_BATCH_SIZE = 100;

type TaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

/**
 * Embeddings de Gemini para la búsqueda por significado del catálogo. Usa la
 * MISMA llave del servidor que el resto de la IA. Nunca lanza: ante un fallo
 * devuelve `null` y el llamador decide (reintentar luego / caer a búsqueda por
 * nombre).
 */
@Injectable()
export class GeminiEmbeddingsClient {
  private readonly logger = new Logger(GeminiEmbeddingsClient.name);

  constructor(private readonly configService: ConfigService) {}

  private get config(): AiConfig {
    return this.configService.getOrThrow<AiConfig>('ai');
  }

  isEnabled(): boolean {
    return this.config.apiKey.length > 0;
  }

  /** Vectores de documentos (productos), en el mismo orden. `null` si falla. */
  async embedDocuments(texts: readonly string[]): Promise<number[][] | null> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = await this.embed(
        texts.slice(i, i + EMBEDDING_BATCH_SIZE),
        'RETRIEVAL_DOCUMENT',
      );
      if (!batch) {
        return null;
      }
      vectors.push(...batch);
    }
    return vectors;
  }

  /** Vector de una consulta del cliente. `null` si falla. */
  async embedQuery(text: string): Promise<number[] | null> {
    const result = await this.embed([text], 'RETRIEVAL_QUERY');
    return result?.[0] ?? null;
  }

  private async embed(texts: readonly string[], taskType: TaskType): Promise<number[][] | null> {
    if (!this.isEnabled() || texts.length === 0) {
      return texts.length === 0 ? [] : null;
    }
    const { baseUrl, apiKey, requestTimeoutMs } = this.config;
    const url = `${baseUrl}/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
    const body = {
      requests: texts.map((text) => ({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: EMBEDDING_DIMENSIONS,
      })),
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) {
        this.logger.warn(
          {
            status: response.status,
            detail: (await response.text().catch(() => '')).slice(0, 300),
          },
          'Gemini embeddings respondió con error',
        );
        return null;
      }
      const data = (await response.json()) as { embeddings?: Array<{ values?: number[] }> };
      const embeddings = data.embeddings ?? [];
      if (
        embeddings.length !== texts.length ||
        embeddings.some((e) => !Array.isArray(e.values) || e.values.length === 0)
      ) {
        this.logger.warn(
          { expected: texts.length, got: embeddings.length },
          'Embeddings incompletos',
        );
        return null;
      }
      return embeddings.map((e) => normalizeVector(e.values as number[]));
    } catch (error) {
      this.logger.error({ err: error }, 'Fallo de red pidiendo embeddings a Gemini');
      return null;
    }
  }
}
