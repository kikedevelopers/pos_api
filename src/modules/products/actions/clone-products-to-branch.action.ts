import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { calculateMargin, calculateProfit } from '@/common/utils/precision';
import { resolveCategoryIdByName } from '@/modules/categories/internal/category-lookups';
import { resolveAutoPackagingId } from '@/modules/packagings/internal/resolve-auto-packaging.helper';

import { assertSourceAndBranch } from '../internal/assert-source-branch';
import { Product, ProductType } from '../entities/product.entity';
import { ProductPrice } from '../entities/product-price.entity';

import type { ProductCreator } from './create-product.action';

/**
 * Motivo por el que un producto NO se clonó a la sucursal.
 *   - `name`    → la sucursal ya tiene un producto activo con el mismo nombre.
 *   - `sku`     → ya tiene uno con el mismo `sku_code`.
 *   - `barcode` → ya tiene uno con el mismo `bar_code`.
 *   - `combo`   → es un producto COMBO: su receta vive en `combo_components` y
 *     apunta a productos del principal. Clonarla exigiría que TODOS sus
 *     componentes se clonaran en el mismo lote y remapear cada
 *     `component_product_id`; clonar el combo sin receta produciría un producto
 *     que se vende SIN descontar inventario. Se omite y se reporta.
 */
export type CloneSkipReason = 'name' | 'sku' | 'barcode' | 'combo';

export interface CloneSkipped {
  name: string;
  reason: CloneSkipReason;
}

export interface CloneProductsResult {
  created: number;
  skipped: CloneSkipped[];
}

/**
 * Fila de producto del ORIGEN (principal) que se va a clonar. Proyección
 * mínima para construir el INSERT en la sucursal.
 */
interface SourceProduct {
  id: string;
  name: string;
  description: string | null;
  product_type: ProductType;
  parent_id: string | null;
  sku_code: string | null;
  bar_code: string | null;
  packaging_id: string | null;
  category_id: string | null;
  cost: number;
  stock: number;
  is_purchasable: boolean;
  show_in_pos: boolean;
  image: string | null;
  hash: string | null;
}

interface SourcePrice {
  product_id: string;
  name: string;
  sale_price: number;
  iva_percentage: number;
}

/**
 * FASE 1 (CLONAR) — Clona productos del negocio PRINCIPAL a una SUCURSAL.
 *
 * --------------------------------------------------------------------------
 * Independencia de inventarios
 * --------------------------------------------------------------------------
 *
 * El clonado es ADITIVO: crea filas NUEVAS en `products`/`product_prices` con
 * `company_id` = sucursal. El flujo de ventas/stock NO se toca: cada company
 * sigue resolviendo su producto por `company_id`, así que vender en la
 * sucursal mueve SOLO su stock, nunca el del principal (y al revés).
 *
 * --------------------------------------------------------------------------
 * Familias (presentaciones / combos)
 * --------------------------------------------------------------------------
 *
 * Las PRESENTACIONES se modelan como productos HIJO vía `parent_id` (FK
 * reflexiva). Por eso clonar = clonar la FAMILIA COMPLETA (padre + hijos)
 * recableando `parent_id` al id del padre clonado vía un mapa `oldId → newId`.
 * Si piden clonar un id que es HIJO, se clona su familia entera (sube al padre)
 * para no dejar huérfanos con `parent_id` colgante.
 *
 * Los COMBO sí tienen tabla propia (`combo_components`) y NO se clonan: se
 * omiten con reason `combo`. Ver `CloneSkipReason`.
 *
 * --------------------------------------------------------------------------
 * Colisiones → OMITIR y reportar
 * --------------------------------------------------------------------------
 *
 * Si la sucursal YA tiene un producto ACTIVO con el mismo `lower(btrim(name))`,
 * `sku_code` o `bar_code`, la FAMILIA NO se clona: se reporta en `skipped` con
 * el motivo. No se pisa ni se duplica. La colisión se evalúa sobre el producto
 * RAÍZ de la familia (los hijos comparten el destino de su padre).
 *
 * --------------------------------------------------------------------------
 * Categoría / empaque por NOMBRE
 * --------------------------------------------------------------------------
 *
 * No se copia el id de origen. La categoría se resuelve por su NOMBRE en la
 * sucursal (`resolveCategoryIdByName`, find-or-create). El empaque se resuelve
 * por su `value` con `resolveAutoPackagingId` en la sucursal — así el factor de
 * conversión de stock es correcto en el destino sin reusar ids del origen.
 *
 * --------------------------------------------------------------------------
 * Transaccionalidad
 * --------------------------------------------------------------------------
 *
 * Una transacción POR FAMILIA: si una familia falla, las otras igual se
 * procesan; nunca queda un estado parcial (padre sin hijos / hijos huérfanos).
 */
@Injectable()
export class CloneProductsToBranchAction {
  private readonly logger = new Logger(CloneProductsToBranchAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    sourceCompanyId: number,
    branchCompanyId: number,
    productIds: number[] | undefined,
    actor: ProductCreator,
  ): Promise<CloneProductsResult> {
    // 1) Validaciones de tenancy/seguridad (fuera de la transacción de datos).
    await assertSourceAndBranch(this.dataSource, sourceCompanyId, branchCompanyId, actor.id);

    // 2) Resolver las RAÍCES de familia a clonar.
    const familyRoots = await this.resolveFamilyRoots(sourceCompanyId, productIds);

    const result: CloneProductsResult = { created: 0, skipped: [] };

    for (const rootId of familyRoots) {
      try {
        const outcome = await this.cloneFamily(sourceCompanyId, branchCompanyId, rootId, actor);
        result.created += outcome.created;
        result.skipped.push(...outcome.skipped);
      } catch (err) {
        // Una familia que peta deja la TX de ESA familia en rollback (sin
        // estado parcial). Registramos y propagamos: un fallo inesperado en el
        // clonado debe ser visible, no silenciado. Las colisiones NO lanzan
        // (se reportan en `skipped`), así que aquí solo caen errores reales.
        this.logger.error({
          event: 'clone.family.failed',
          sourceCompanyId,
          branchCompanyId,
          rootId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    this.logger.log({
      event: 'clone.products.completed',
      sourceCompanyId,
      branchCompanyId,
      created: result.created,
      skipped: result.skipped.length,
    });

    return result;
  }

  /**
   * Resuelve el conjunto de RAÍCES de familia a clonar.
   *   - Sin ids (o vacío) → todas las raíces activas del principal (parent_id
   *     null). Sus hijos se clonan junto con cada raíz.
   *   - Con ids → para cada id, sube a su raíz (si es hijo, su `parent_id`); se
   *     deduplican las raíces para no clonar una familia dos veces.
   *
   * Solo productos ACTIVOS (`is_archived = false`).
   */
  private async resolveFamilyRoots(
    sourceCompanyId: number,
    productIds: number[] | undefined,
  ): Promise<string[]> {
    if (!productIds || productIds.length === 0) {
      const rows = await this.dataSource.query<Array<{ id: string }>>(
        `SELECT id FROM products
         WHERE company_id = $1 AND is_archived = false AND parent_id IS NULL
         ORDER BY id`,
        [String(sourceCompanyId)],
      );
      return rows.map((r) => r.id);
    }

    const uniqueIds = Array.from(new Set(productIds.map((id) => String(id))));
    const rows = await this.dataSource.query<Array<{ id: string; parent_id: string | null }>>(
      `SELECT id, parent_id FROM products
       WHERE company_id = $1 AND is_archived = false AND id = ANY($2::bigint[])`,
      [String(sourceCompanyId), uniqueIds],
    );
    const roots = new Set<string>();
    for (const row of rows) {
      roots.add(row.parent_id ?? row.id);
    }
    return Array.from(roots).sort((a, b) => Number(a) - Number(b));
  }

  /**
   * Clona una familia (raíz + hijos activos) dentro de UNA transacción.
   * Evalúa colisión sobre la raíz; si choca, NO clona nada de la familia.
   */
  private async cloneFamily(
    sourceCompanyId: number,
    branchCompanyId: number,
    rootId: string,
    actor: ProductCreator,
  ): Promise<CloneProductsResult> {
    return this.dataSource.transaction<CloneProductsResult>(async (manager) => {
      const family = await this.loadFamily(manager, sourceCompanyId, rootId);
      if (family.length === 0) {
        return { created: 0, skipped: [] };
      }
      const root = family[0];

      // Un COMBO no se clona: su receta referencia productos del principal y
      // clonarlo sin ella daría un producto que se vende sin descontar stock.
      if (root.product_type === ProductType.COMBO) {
        return { created: 0, skipped: [{ name: root.name, reason: 'combo' }] };
      }

      // Colisión: se evalúa sobre la RAÍZ. Si la sucursal ya tiene un activo con
      // el mismo name/sku/barcode, se omite la familia entera.
      const collision = await this.detectCollision(manager, branchCompanyId, root);
      if (collision) {
        return { created: 0, skipped: [{ name: root.name, reason: collision }] };
      }

      // Mapa oldId → newId para recablear parent_id de los hijos.
      const idMap = new Map<string, string>();
      let created = 0;

      // El padre primero (los hijos dependen de su new id).
      for (const product of family) {
        const newParentId =
          product.parent_id !== null ? (idMap.get(product.parent_id) ?? null) : null;
        const newId = await this.cloneOne(
          manager,
          sourceCompanyId,
          branchCompanyId,
          product,
          newParentId,
          actor,
        );
        idMap.set(product.id, newId);
        created += 1;
      }

      return { created, skipped: [] };
    });
  }

  /**
   * Carga la familia ordenada: la raíz primero, luego los hijos. Solo activos.
   */
  private async loadFamily(
    manager: EntityManager,
    sourceCompanyId: number,
    rootId: string,
  ): Promise<SourceProduct[]> {
    const rows = await manager.query<
      Array<{
        id: string;
        name: string;
        description: string | null;
        product_type: ProductType;
        parent_id: string | null;
        sku_code: string | null;
        bar_code: string | null;
        packaging_id: string | null;
        category_id: string | null;
        cost: string;
        stock: string;
        is_purchasable: boolean;
        show_in_pos: boolean;
        image: string | null;
        hash: string | null;
      }>
    >(
      `SELECT id, name, description, product_type, parent_id, sku_code, bar_code,
              packaging_id, category_id, cost, stock, is_purchasable, show_in_pos, image, hash
       FROM products
       WHERE company_id = $1 AND is_archived = false AND (id = $2 OR parent_id = $2)
       ORDER BY (parent_id IS NOT NULL), id`,
      [String(sourceCompanyId), rootId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      product_type: r.product_type,
      parent_id: r.parent_id,
      sku_code: r.sku_code,
      bar_code: r.bar_code,
      packaging_id: r.packaging_id,
      category_id: r.category_id,
      cost: Number(r.cost),
      stock: Number(r.stock),
      is_purchasable: r.is_purchasable,
      show_in_pos: r.show_in_pos,
      image: r.image,
      hash: r.hash,
    }));
  }

  /**
   * Detecta colisión activa en la sucursal por name (case+trim insensible),
   * sku_code o bar_code. Devuelve el motivo o `null`. Prioriza name → sku →
   * barcode (orden de evaluación de los índices únicos parciales).
   */
  private async detectCollision(
    manager: EntityManager,
    branchCompanyId: number,
    source: SourceProduct,
  ): Promise<CloneSkipReason | null> {
    const byName = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM products
       WHERE company_id = $1 AND is_archived = false
         AND lower(btrim(name)) = lower(btrim($2))
       LIMIT 1`,
      [String(branchCompanyId), source.name],
    );
    if (byName.length > 0) {
      return 'name';
    }
    if (source.sku_code) {
      const bySku = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM products
         WHERE company_id = $1 AND is_archived = false AND sku_code = $2 LIMIT 1`,
        [String(branchCompanyId), source.sku_code],
      );
      if (bySku.length > 0) {
        return 'sku';
      }
    }
    if (source.bar_code) {
      const byBar = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM products
         WHERE company_id = $1 AND is_archived = false AND bar_code = $2 LIMIT 1`,
        [String(branchCompanyId), source.bar_code],
      );
      if (byBar.length > 0) {
        return 'barcode';
      }
    }
    return null;
  }

  /**
   * Clona un único producto a la sucursal: resuelve categoría/empaque por
   * nombre/valor en el destino, inserta el Product y copia sus precios
   * recalculando profit/margin con Big.js contra el cost clonado. Devuelve el
   * nuevo id.
   */
  private async cloneOne(
    manager: EntityManager,
    sourceCompanyId: number,
    branchCompanyId: number,
    source: SourceProduct,
    newParentId: string | null,
    actor: ProductCreator,
  ): Promise<string> {
    // Categoría por NOMBRE (find-or-create en la sucursal).
    let categoryId: string | null = null;
    if (source.category_id !== null) {
      const catName = await this.loadCategoryName(manager, source.category_id);
      if (catName) {
        categoryId = await resolveCategoryIdByName(manager, catName, branchCompanyId);
      }
    }

    // Empaque por VALUE (find-or-create auto en la sucursal). El factor de
    // conversión vive en `value`; reusar el id del origen sería cross-tenant.
    let packagingId: string | null = null;
    if (source.packaging_id !== null) {
      const pkgValue = await this.loadPackagingValue(manager, source.packaging_id);
      if (pkgValue !== null && pkgValue > 0) {
        packagingId = await resolveAutoPackagingId(manager, pkgValue, branchCompanyId, {
          id: actor.id,
          fullName: actor.fullName,
        });
      }
    }

    const inserted = await manager.insert(Product, {
      company_id: String(branchCompanyId),
      name: source.name,
      description: source.description,
      product_type: source.product_type,
      parent_id: newParentId,
      sku_code: source.sku_code,
      bar_code: source.bar_code,
      packaging_id: packagingId,
      category_id: categoryId,
      cost: source.cost,
      stock: source.stock,
      is_purchasable: source.is_purchasable,
      show_in_pos: source.show_in_pos,
      image: source.image,
      hash: source.hash,
      is_archived: false,
      // Marca de COPIA: registra la company de origen (el principal) para que la
      // sucursal distinga "Copia" de "Propio".
      cloned_from_company_id: String(sourceCompanyId),
      created_by: actor.fullName,
      created_by_id: String(actor.id),
    });
    const newId = inserted.identifiers[0].id as string;

    // Precios: copiar recalculando profit/margin con Big.js contra el cost
    // clonado (fuente de verdad servidor).
    const prices = await this.loadSourcePrices(manager, source.id);
    if (prices.length > 0) {
      await manager.insert(
        ProductPrice,
        prices.map((p) => ({
          company_id: String(branchCompanyId),
          product_id: newId,
          name: p.name,
          sale_price: p.sale_price,
          profit: calculateProfit(p.sale_price, source.cost),
          margin: calculateMargin(p.sale_price, source.cost),
          iva_percentage: p.iva_percentage,
          created_by: actor.fullName,
          created_by_id: String(actor.id),
        })),
      );
    }

    return newId;
  }

  private async loadCategoryName(
    manager: EntityManager,
    categoryId: string,
  ): Promise<string | null> {
    const rows = await manager.query<Array<{ name: string }>>(
      `SELECT name FROM categories WHERE id = $1`,
      [categoryId],
    );
    return rows.length > 0 ? rows[0].name : null;
  }

  private async loadPackagingValue(
    manager: EntityManager,
    packagingId: string,
  ): Promise<number | null> {
    const rows = await manager.query<Array<{ value: string }>>(
      `SELECT value FROM packagings WHERE id = $1`,
      [packagingId],
    );
    return rows.length > 0 ? Number(rows[0].value) : null;
  }

  private async loadSourcePrices(
    manager: EntityManager,
    productId: string,
  ): Promise<SourcePrice[]> {
    const rows = await manager.query<
      Array<{ product_id: string; name: string; sale_price: string; iva_percentage: string }>
    >(
      `SELECT product_id, name, sale_price, iva_percentage
       FROM product_prices WHERE product_id = $1 ORDER BY id`,
      [productId],
    );
    return rows.map((r) => ({
      product_id: r.product_id,
      name: r.name,
      sale_price: Number(r.sale_price),
      iva_percentage: Number(r.iva_percentage),
    }));
  }
}
