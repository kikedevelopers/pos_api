import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { accessibleProductsPredicate } from '@/modules/products/internal/accessible-products.helper';

import { EMBEDDING_MODEL, GeminiEmbeddingsClient } from './internal/gemini-embeddings.client';
import {
  buildFamilyText,
  sanitizeAttributes,
  sanitizeTags,
  textHash,
  topMatches,
  type ScoredId,
} from './internal/profile';

/** Familias que se indexan como máximo por llamada (si no se indica otro tope). */
export const INDEX_BATCH_LIMIT = 60;

/** Similitud mínima para considerar que un producto responde a la necesidad. */
export const MIN_SEMANTIC_SCORE = 0.6;

/** Distancia máxima al mejor resultado para seguir siendo candidato. */
export const SEMANTIC_SCORE_WINDOW = 0.06;

/** Vigencia de los vectores cacheados por negocio. */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface FamilyRow {
  id: string;
  company_id: string;
  name: string;
  category: string | null;
  presentations: string[] | null;
  description: string | null;
  uses: unknown;
  attributes: unknown;
  aliases: unknown;
  text_hash: string | null;
  model: string | null;
}

export interface IndexResult {
  /** Familias (re)indexadas en esta corrida. */
  indexed: number;
  /** Familias que siguen pendientes (se toman en la próxima corrida). */
  pending: number;
}

/**
 * Búsqueda por SIGNIFICADO del catálogo: cada familia (producto base +
 * presentaciones + ficha "Para el asistente") tiene un vector de Gemini; una
 * necesidad del cliente ("algo para hamburguesa y papas") se convierte en
 * vector y se compara.
 *
 * Indexación incremental: el `text_hash` dice qué familias cambiaron; solo esas
 * se recalculan. La similitud se calcula aquí (sin pgvector), con los vectores
 * del negocio en caché.
 */
@Injectable()
export class CatalogSemanticService {
  private readonly logger = new Logger(CatalogSemanticService.name);
  private readonly cache = new Map<
    number,
    { at: number; items: Array<{ id: number; vector: Float32Array }> }
  >();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly embeddings: GeminiEmbeddingsClient,
  ) {}

  isEnabled(): boolean {
    return this.embeddings.isEnabled();
  }

  /**
   * (Re)indexa hasta `limit` familias del negocio cuyo texto cambió o que no
   * tienen vector. Seguro de llamar seguido: lo que no cambió no se toca.
   */
  async indexCompany(
    companyId: number,
    limit: number = INDEX_BATCH_LIMIT,
    priorityIds: readonly number[] = [],
  ): Promise<IndexResult> {
    if (!this.isEnabled()) {
      return { indexed: 0, pending: 0 };
    }
    const families = await this.loadFamilies(companyId);
    const stale = families
      .map((row) => {
        const text = buildFamilyText({
          name: row.name,
          category: row.category,
          presentations: row.presentations ?? [],
          profile:
            row.description !== null
              ? {
                  description: row.description,
                  uses: sanitizeTags(row.uses),
                  attributes: sanitizeAttributes(row.attributes),
                  aliases: sanitizeTags(row.aliases),
                }
              : null,
        });
        return { row, text, hash: textHash(text) };
      })
      .filter(({ row, hash }) => row.text_hash !== hash || row.model !== EMBEDDING_MODEL);

    // Lo recién editado va primero (el dueño espera verlo reflejado ya).
    const priority = new Set(priorityIds);
    stale.sort(
      (a, b) => Number(priority.has(Number(b.row.id))) - Number(priority.has(Number(a.row.id))),
    );
    const batch = stale.slice(0, limit);
    if (batch.length === 0) {
      return { indexed: 0, pending: 0 };
    }

    const vectors = await this.embeddings.embedDocuments(batch.map((item) => item.text));
    if (!vectors) {
      this.logger.warn(
        { companyId, pending: stale.length },
        'No se pudieron calcular los vectores; se reintenta en la próxima corrida',
      );
      return { indexed: 0, pending: stale.length };
    }

    await this.dataSource.transaction(async (manager) => {
      for (let i = 0; i < batch.length; i += 1) {
        const { row, hash } = batch[i];
        await manager.query(
          `INSERT INTO product_search_embeddings (company_id, product_id, model, text_hash, embedding)
           VALUES ($1, $2, $3, $4, $5::real[])
           ON CONFLICT (product_id) DO UPDATE
             SET company_id = EXCLUDED.company_id,
                 model      = EXCLUDED.model,
                 text_hash  = EXCLUDED.text_hash,
                 embedding  = EXCLUDED.embedding,
                 updated_at = now()`,
          [row.company_id, row.id, EMBEDDING_MODEL, hash, vectors[i]],
        );
      }
    });
    // Un producto compartido puede estar en la caché de varios negocios.
    this.cache.clear();
    return { indexed: batch.length, pending: stale.length - batch.length };
  }

  /**
   * Familias (ids del producto base) que mejor responden a la necesidad, de
   * más a menos parecida. Vacío si la IA no está o no hay nada parecido.
   */
  async search(companyId: number, need: string, limit = 6): Promise<ScoredId[]> {
    const query = need.trim();
    if (!query || !this.isEnabled()) {
      return [];
    }
    const [vector, items] = await Promise.all([
      this.embeddings.embedQuery(query),
      this.vectors(companyId),
    ]);
    if (!vector || items.length === 0) {
      return [];
    }
    return topMatches(vector, items, limit, MIN_SEMANTIC_SCORE, SEMANTIC_SCORE_WINDOW);
  }

  private async vectors(companyId: number): Promise<Array<{ id: number; vector: Float32Array }>> {
    const cached = this.cache.get(companyId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.items;
    }
    const access = accessibleProductsPredicate('p', companyId, 1);
    const rows = await this.dataSource.query<Array<{ product_id: string; embedding: number[] }>>(
      `SELECT e.product_id, e.embedding
         FROM product_search_embeddings e
         JOIN products p ON p.id = e.product_id
        WHERE p.is_archived = false
          AND e.model = $${access.params.length + 1}
          AND ${access.sql}`,
      [...access.params, EMBEDDING_MODEL],
    );
    const items = rows.map((row) => ({
      id: Number(row.product_id),
      vector: Float32Array.from(row.embedding),
    }));
    this.cache.set(companyId, { at: Date.now(), items });
    return items;
  }

  /** Familias del catálogo del negocio (bases activas) con su ficha y su vector actual. */
  private loadFamilies(companyId: number): Promise<FamilyRow[]> {
    const access = accessibleProductsPredicate('p', companyId, 1);
    return this.dataSource.query<FamilyRow[]>(
      `SELECT
         p.id,
         p.company_id,
         p.name,
         cat.name AS category,
         (
           SELECT array_agg(c.name ORDER BY c.name)
             FROM products c
            WHERE c.parent_id = p.id AND c.is_archived = false
         ) AS presentations,
         pap.description,
         pap.uses,
         pap.attributes,
         pap.aliases,
         e.text_hash,
         e.model
       FROM products p
       LEFT JOIN categories cat ON cat.id = p.category_id
       LEFT JOIN product_assistant_profiles pap ON pap.product_id = p.id
       LEFT JOIN product_search_embeddings e ON e.product_id = p.id
      WHERE p.parent_id IS NULL
        AND p.is_archived = false
        AND p.product_type IN ('SIMPLE', 'COMBO')
        AND ${access.sql}
      ORDER BY p.id ASC`,
      access.params,
    );
  }
}
