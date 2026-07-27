import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

import { PRODUCT_TREE_CTE, PRODUCT_PROTECTION_CTE } from './tenant-inventory.sql';

export interface ClearTenantInventoryResult {
  /** Productos borrados físicamente (no tenían historial de negocio). */
  deleted: number;
  /** Productos archivados por tener historial (o pertenecer a un árbol que lo tiene). */
  archived: number;
  /** Productos activos que quedan tras la operación. Debe ser 0. */
  remaining: number;
}

/** Tope de vueltas del borrado por niveles; la jerarquía real es de 2–3. */
const MAX_DEPTH_PASSES = 12;

/**
 * Vacía el inventario de un tenant desde el panel superadmin. IRREVERSIBLE en
 * su parte destructiva.
 *
 * Estrategia (acordada con el negocio):
 *   - Producto SIN historial de negocio → se BORRA. Su `product_prices` e
 *     `inventory_shares` caen por cascada de la FK; su historial interno de
 *     costo/precio se borra explícitamente (esas FK son NO ACTION).
 *   - Producto CON historial (ventas, compras, notas o movimientos), o que
 *     pertenece a un árbol donde alguien lo tiene → se ARCHIVA. El histórico de
 *     ventas del cliente queda intacto y, como los índices únicos de
 *     nombre/SKU/código son parciales (`WHERE is_archived = false`), el nombre
 *     queda libre para volver a cargar el catálogo.
 *
 * En ambos casos el cliente ve su inventario en cero. Categorías, empaques y
 * proveedores NO se tocan: al recargar se reutilizan por nombre.
 */
@Injectable()
export class ClearTenantInventoryAction {
  private readonly logger = new Logger(ClearTenantInventoryAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number): Promise<ClearTenantInventoryResult> {
    return this.dataSource.transaction(async (manager) => {
      const company = await manager
        .getRepository(Company)
        .findOne({ where: { id: String(companyId) } });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} no existe.`);
      }

      const { deletableIds, protectedIds } = await this.classify(manager, companyId);

      const archived = await this.archive(manager, protectedIds);
      const deleted = await this.deleteProducts(manager, deletableIds);

      const [{ remaining }] = await manager.query<{ remaining: string }[]>(
        `SELECT count(*) AS remaining FROM products WHERE company_id = $1 AND is_archived = false`,
        [companyId],
      );

      this.logger.log(
        `Inventario vaciado (company ${companyId}): ${deleted} borrados, ${archived} archivados.`,
      );
      return { deleted, archived, remaining: Number(remaining) };
    });
  }

  /**
   * Separa los productos de la company en borrables y protegidos. Incluye los ya
   * archivados: si no tienen historial también se borran (limpieza), y si lo
   * tienen simplemente siguen archivados.
   */
  private async classify(
    manager: EntityManager,
    companyId: number,
  ): Promise<{ deletableIds: string[]; protectedIds: string[] }> {
    const rows = await manager.query<{ id: string; protected: boolean; is_archived: boolean }[]>(
      `
      ${PRODUCT_TREE_CTE},
      ${PRODUCT_PROTECTION_CTE}
      SELECT p.id, pr.protected, p.is_archived
      FROM prod p
      JOIN protection pr ON pr.id = p.id
      `,
      [companyId],
    );

    return {
      deletableIds: rows.filter((r) => !r.protected).map((r) => r.id),
      // Los ya archivados no se vuelven a tocar (nada que cambiar).
      protectedIds: rows.filter((r) => r.protected && !r.is_archived).map((r) => r.id),
    };
  }

  /** Archiva los protegidos: salen del POS y del inventario, sin perder historia. */
  private async archive(manager: EntityManager, ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await manager.query<unknown[]>(
      `UPDATE products
          SET is_archived = true,
              show_in_pos = false,
              updated_by = 'superadmin',
              updated_at = now()
        WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    // `query` de un UPDATE devuelve [rows, affected]; TypeORM expone el conteo aparte.
    return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : ids.length;
  }

  /**
   * Borra los productos sin historial. Primero su historial interno (FK NO
   * ACTION) y luego los productos "de abajo hacia arriba": en cada vuelta se
   * borran los que ya no tienen hijos, de modo que `products.parent_id` nunca
   * se viola por mucha profundidad que tenga la jerarquía.
   */
  private async deleteProducts(manager: EntityManager, ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    await manager.query(`DELETE FROM product_cost_history WHERE product_id = ANY($1::bigint[])`, [
      ids,
    ]);
    await manager.query(`DELETE FROM product_price_history WHERE product_id = ANY($1::bigint[])`, [
      ids,
    ]);

    let deleted = 0;
    for (let pass = 0; pass < MAX_DEPTH_PASSES && deleted < ids.length; pass++) {
      const removed = await manager.query<{ id: string }[]>(
        `DELETE FROM products p
          WHERE p.id = ANY($1::bigint[])
            AND NOT EXISTS (SELECT 1 FROM products c WHERE c.parent_id = p.id)
          RETURNING p.id`,
        [ids],
      );
      if (removed.length === 0) {
        break;
      }
      deleted += removed.length;
    }

    if (deleted < ids.length) {
      // No debería ocurrir: significaría una jerarquía cíclica o una FK nueva
      // sin contemplar. Se avisa en vez de dejarlo pasar en silencio.
      this.logger.warn(
        `Quedaron ${ids.length - deleted} productos sin borrar (jerarquía inesperada).`,
      );
    }
    return deleted;
  }
}
