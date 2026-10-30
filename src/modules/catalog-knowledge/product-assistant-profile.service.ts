import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { accessibleProductsPredicate } from '@/modules/products/internal/accessible-products.helper';

import { ProductAssistantProfileEntity } from './entities/product-assistant-profile.entity';
import {
  EMPTY_PROFILE,
  sanitizeProfile,
  type AssistantProfileInput,
  type RelatedKind,
} from './internal/profile';

/** Producto relacionado tal como lo ve la UI (con nombre). */
export interface RelatedProductView {
  product_id: number;
  kind: RelatedKind;
  name: string;
}

/** Ficha "Para el asistente" que devuelve el API. */
export interface AssistantProfileView extends Omit<AssistantProfileInput, 'related'> {
  product_id: number;
  related: RelatedProductView[];
  updated_at: string | null;
}

interface ProductRow {
  id: string;
  company_id: string;
  parent_id: string | null;
  is_archived: boolean;
}

/**
 * Ficha "Para el asistente" de un producto BASE: la edita el dueño (o la
 * completa la IA y él la revisa). Solo se guarda en productos PROPIOS del
 * negocio (no en los compartidos por otra sucursal) y nunca en presentaciones:
 * la ficha describe al producto y sus presentaciones la heredan.
 */
@Injectable()
export class ProductAssistantProfileService {
  constructor(
    @InjectRepository(ProductAssistantProfileEntity)
    private readonly repo: Repository<ProductAssistantProfileEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async get(companyId: number, productId: number): Promise<AssistantProfileView> {
    await this.ownBaseProduct(companyId, productId);
    const entity = await this.repo.findOne({ where: { product_id: String(productId) } });
    return this.toView(companyId, productId, entity);
  }

  async update(
    companyId: number,
    productId: number,
    raw: Partial<Record<keyof AssistantProfileInput, unknown>>,
  ): Promise<AssistantProfileView> {
    await this.ownBaseProduct(companyId, productId);
    const profile = sanitizeProfile(raw, productId);

    // Relacionados: solo productos que este negocio puede vender.
    const allowed = await this.accessibleIds(
      companyId,
      profile.related.map((r) => r.product_id),
    );
    const missing = profile.related.filter((r) => !allowed.has(r.product_id));
    if (missing.length > 0) {
      throw new BadRequestException(
        'Algún producto relacionado no existe, está archivado o no es de este negocio.',
      );
    }

    const existing = await this.repo.findOne({ where: { product_id: String(productId) } });
    const entity =
      existing ??
      this.repo.create({ company_id: String(companyId), product_id: String(productId) });
    entity.description = profile.description;
    entity.uses = profile.uses;
    entity.attributes = profile.attributes;
    entity.aliases = profile.aliases;
    entity.related = profile.related;
    const saved = await this.repo.save(entity);
    return this.toView(companyId, productId, saved);
  }

  /** El producto existe, es del negocio, no está archivado y es BASE. */
  private async ownBaseProduct(companyId: number, productId: number): Promise<void> {
    const rows = await this.dataSource.query<ProductRow[]>(
      'SELECT id, company_id, parent_id, is_archived FROM products WHERE id = $1 LIMIT 1',
      [productId],
    );
    const product = rows[0];
    if (!product || Number(product.company_id) !== companyId || product.is_archived) {
      throw new NotFoundException('Producto no encontrado.');
    }
    if (product.parent_id !== null) {
      throw new BadRequestException(
        'La ficha para el asistente se completa en el producto base; sus presentaciones la heredan.',
      );
    }
  }

  private async accessibleIds(companyId: number, ids: number[]): Promise<Set<number>> {
    if (ids.length === 0) {
      return new Set();
    }
    const access = accessibleProductsPredicate('p', companyId, 1);
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT p.id FROM products p
        WHERE p.id = ANY($${access.params.length + 1}::bigint[])
          AND p.is_archived = false
          AND ${access.sql}`,
      [...access.params, ids.map(String)],
    );
    return new Set(rows.map((row) => Number(row.id)));
  }

  private async toView(
    companyId: number,
    productId: number,
    entity: ProductAssistantProfileEntity | null,
  ): Promise<AssistantProfileView> {
    const profile = entity ? sanitizeProfile(entity, productId) : EMPTY_PROFILE;
    const ids = profile.related.map((r) => r.product_id);
    const names = new Map<number, string>();
    if (ids.length > 0) {
      const access = accessibleProductsPredicate('p', companyId, 1);
      const rows = await this.dataSource.query<Array<{ id: string; name: string }>>(
        `SELECT p.id, p.name FROM products p
          WHERE p.id = ANY($${access.params.length + 1}::bigint[])
            AND p.is_archived = false
            AND ${access.sql}`,
        [...access.params, ids.map(String)],
      );
      for (const row of rows) {
        names.set(Number(row.id), row.name);
      }
    }
    return {
      product_id: productId,
      description: profile.description,
      uses: profile.uses,
      attributes: profile.attributes,
      aliases: profile.aliases,
      // Un relacionado que se archivó después desaparece de la ficha.
      related: profile.related
        .filter((r) => names.has(r.product_id))
        .map((r) => ({ ...r, name: names.get(r.product_id) as string })),
      updated_at: entity?.updated_at ? entity.updated_at.toISOString() : null,
    };
  }
}
