import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { assertSourceAndBranch } from '../internal/assert-source-branch';

import type { ProductCreator } from './create-product.action';

export interface ShareProductsResult {
  shared: number;
  mode: 'all' | 'products';
}

export interface ShareListItem {
  id: number;
  product_id: number | null;
  created_at: string;
}

/**
 * FASE 2 (COMPARTIR) — Gestiona los `inventory_shares` del PRINCIPAL hacia una
 * SUCURSAL. Compartir es SOLO LECTURA/VENTA: el producto sigue siendo del
 * principal (su stock es la única fuente de verdad).
 *
 *   - `share`  → crea filas en inventory_shares (idempotente, omite duplicados).
 *   - `list`   → lista los shares del par (source = principal, target = sucursal).
 *   - `unshare`→ borra el share de un producto o TODO el par.
 *
 * Validación de tenancy idéntica a clone (`assertSourceAndBranch`): origen =
 * principal del JWT, destino = sucursal del owner (miembro).
 */
@Injectable()
export class ShareProductsToBranchAction {
  private readonly logger = new Logger(ShareProductsToBranchAction.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Comparte productos. Sin `productIds` → un único share company-level
   * (product_id NULL). Con ids → un share product-level por producto (solo de
   * productos que existan y pertenezcan al principal). Idempotente: los
   * duplicados se omiten vía los índices únicos parciales.
   */
  async execute(
    sourceCompanyId: number,
    branchCompanyId: number,
    productIds: number[] | undefined,
    actor: ProductCreator,
  ): Promise<ShareProductsResult> {
    await assertSourceAndBranch(this.dataSource, sourceCompanyId, branchCompanyId, actor.id);

    if (!productIds || productIds.length === 0) {
      const shared = await this.shareAll(sourceCompanyId, branchCompanyId, actor.id);
      this.logger.log({
        event: 'inventory.share.all',
        sourceCompanyId,
        branchCompanyId,
        shared,
      });
      return { shared, mode: 'all' };
    }

    const shared = await this.shareProducts(sourceCompanyId, branchCompanyId, productIds, actor.id);
    this.logger.log({
      event: 'inventory.share.products',
      sourceCompanyId,
      branchCompanyId,
      shared,
    });
    return { shared, mode: 'products' };
  }

  /**
   * Inserta (si no existe) un share company-level. Idempotente vía
   * `uq_inventory_shares_company_level`. Devuelve 1 si insertó, 0 si ya existía.
   */
  private async shareAll(
    sourceCompanyId: number,
    branchCompanyId: number,
    userId: number,
  ): Promise<number> {
    const inserted = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO inventory_shares (source_company_id, target_company_id, product_id, created_by_id)
       VALUES ($1, $2, NULL, $3)
       ON CONFLICT (source_company_id, target_company_id) WHERE product_id IS NULL
       DO NOTHING
       RETURNING id`,
      [String(sourceCompanyId), String(branchCompanyId), String(userId)],
    );
    return inserted.length;
  }

  /**
   * Inserta shares product-level para los productos del principal indicados.
   * Solo comparte ids que EXISTAN y pertenezcan al principal (ignora ajenos /
   * inexistentes — defensa cross-tenant). Idempotente vía
   * `uq_inventory_shares_product_level`. Devuelve cuántos shares NUEVOS se crearon.
   */
  private async shareProducts(
    sourceCompanyId: number,
    branchCompanyId: number,
    productIds: number[],
    userId: number,
  ): Promise<number> {
    const uniqueIds = Array.from(new Set(productIds.map((id) => String(id))));
    // Filtrar a los que de verdad pertenecen al principal.
    const owned = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM products WHERE company_id = $1 AND id = ANY($2::bigint[])`,
      [String(sourceCompanyId), uniqueIds],
    );
    if (owned.length === 0) {
      return 0;
    }
    const inserted = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO inventory_shares (source_company_id, target_company_id, product_id, created_by_id)
       SELECT $1, $2, pid, $3 FROM unnest($4::bigint[]) AS pid
       ON CONFLICT (source_company_id, target_company_id, product_id) WHERE product_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        String(sourceCompanyId),
        String(branchCompanyId),
        String(userId),
        owned.map((r) => r.id),
      ],
    );
    return inserted.length;
  }

  /**
   * Lista los shares del par (source principal → target sucursal).
   */
  async list(
    sourceCompanyId: number,
    branchCompanyId: number,
    userId: number,
  ): Promise<ShareListItem[]> {
    await assertSourceAndBranch(this.dataSource, sourceCompanyId, branchCompanyId, userId);
    const rows = await this.dataSource.query<
      Array<{ id: string; product_id: string | null; created_at: Date }>
    >(
      `SELECT id, product_id, created_at FROM inventory_shares
       WHERE source_company_id = $1 AND target_company_id = $2
       ORDER BY (product_id IS NOT NULL), id`,
      [String(sourceCompanyId), String(branchCompanyId)],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      product_id: r.product_id !== null ? Number(r.product_id) : null,
      created_at: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
    }));
  }

  /**
   * Descomparte: con `productId` borra el share product-level de ese producto;
   * sin `productId` borra TODO el par (company-level + todos los product-level).
   * Devuelve cuántas filas se borraron.
   */
  async unshare(
    sourceCompanyId: number,
    branchCompanyId: number,
    productId: number | undefined,
    userId: number,
  ): Promise<number> {
    await assertSourceAndBranch(this.dataSource, sourceCompanyId, branchCompanyId, userId);

    if (typeof productId === 'number') {
      const res = await this.dataSource.query<unknown[]>(
        `DELETE FROM inventory_shares
         WHERE source_company_id = $1 AND target_company_id = $2 AND product_id = $3
         RETURNING id`,
        [String(sourceCompanyId), String(branchCompanyId), String(productId)],
      );
      return res.length;
    }

    const res = await this.dataSource.query<unknown[]>(
      `DELETE FROM inventory_shares
       WHERE source_company_id = $1 AND target_company_id = $2
       RETURNING id`,
      [String(sourceCompanyId), String(branchCompanyId)],
    );
    return res.length;
  }
}
