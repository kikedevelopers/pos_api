import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { GeminiClient } from '@/modules/ai/internal/gemini-client';

import {
  parseProfileSuggestion,
  buildSuggestionPrompt,
  type ProfileSuggestion,
} from './internal/suggestion';

interface ProductContextRow {
  name: string;
  company_id: string;
  parent_id: string | null;
  is_archived: boolean;
  category: string | null;
  business: string | null;
  presentations: string[] | null;
}

/**
 * "Completar con IA": propone la ficha "Para el asistente" de un producto base
 * a partir de su nombre, categoría y presentaciones. NO guarda nada: el dueño
 * revisa la propuesta en el formulario y decide.
 */
@Injectable()
export class SuggestAssistantProfileAction {
  private readonly logger = new Logger(SuggestAssistantProfileAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly gemini: GeminiClient,
  ) {}

  async execute(companyId: number, productId: number): Promise<ProfileSuggestion> {
    if (!this.gemini.isEnabled()) {
      throw new ServiceUnavailableException('La IA no está disponible en este momento.');
    }
    const rows = await this.dataSource.query<ProductContextRow[]>(
      `SELECT p.name, p.company_id, p.parent_id, p.is_archived,
              cat.name AS category,
              co.name AS business,
              (SELECT array_agg(c.name ORDER BY c.name)
                 FROM products c
                WHERE c.parent_id = p.id AND c.is_archived = false) AS presentations
         FROM products p
         LEFT JOIN categories cat ON cat.id = p.category_id
         LEFT JOIN companies co ON co.id = p.company_id
        WHERE p.id = $1
        LIMIT 1`,
      [productId],
    );
    const product = rows[0];
    if (
      !product ||
      Number(product.company_id) !== companyId ||
      product.is_archived ||
      product.parent_id !== null
    ) {
      throw new NotFoundException('Producto no encontrado.');
    }

    const body = {
      contents: [
        {
          role: 'user' as const,
          parts: [
            {
              text: buildSuggestionPrompt({
                name: product.name,
                category: product.category,
                presentations: product.presentations ?? [],
                business: product.business,
              }),
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        topP: 0.95,
        maxOutputTokens: 1024,
        // `thinkingBudget: 0` lo rechaza el modelo (400): se deja el de defecto.
        responseMimeType: 'application/json',
      },
    };
    const model = this.gemini.resolveModel();
    const result = await this.gemini.streamRound(body, { model, onText: () => undefined });
    const suggestion = result.error ? null : parseProfileSuggestion(result.text);
    if (!suggestion) {
      this.logger.warn({ productId, error: result.error }, 'La IA no devolvió una ficha válida');
      throw new ServiceUnavailableException(
        'La IA no pudo proponer la ficha en este momento. Inténtalo de nuevo.',
      );
    }
    return suggestion;
  }
}
