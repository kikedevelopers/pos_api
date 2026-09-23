import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

import { CUSTOMER_PROTECTION_CTE } from './tenant-customers.sql';

export interface ClearTenantCustomersResult {
  /** Clientes borrados físicamente (no tenían historial de negocio). */
  deleted: number;
  /** Clientes archivados por tener historial (ventas, créditos, notas o anticipos). */
  archived: number;
  /** Clientes activos que quedan tras la operación. Debe ser 0. */
  remaining: number;
}

/**
 * Vacía la lista de clientes de un tenant desde el panel superadmin.
 * IRREVERSIBLE en su parte destructiva.
 *
 * Estrategia (espejo de `clear-tenant-inventory`):
 *   - Cliente SIN historial de negocio → se BORRA. No lo referencia ninguna de
 *     las cuatro tablas con FK a `customers`, así que el DELETE es seguro.
 *   - Cliente CON historial (ventas, créditos, notas de ajuste o anticipos) →
 *     se ARCHIVA. El histórico del cliente queda intacto y, como los índices
 *     únicos de la tabla son parciales, el registro deja de estorbar.
 *
 * En ambos casos el cliente ve su lista en cero. No se tocan ventas, créditos,
 * notas ni anticipos: solo el registro del cliente.
 */
@Injectable()
export class ClearTenantCustomersAction {
  private readonly logger = new Logger(ClearTenantCustomersAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number): Promise<ClearTenantCustomersResult> {
    return this.dataSource.transaction(async (manager) => {
      const company = await manager
        .getRepository(Company)
        .findOne({ where: { id: String(companyId) } });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} no existe.`);
      }

      const { deletableIds, protectedIds } = await this.classify(manager, companyId);

      const archived = await this.archive(manager, protectedIds);
      const deleted = await this.deleteCustomers(manager, deletableIds);

      const [{ remaining }] = await manager.query<{ remaining: string }[]>(
        `SELECT count(*) AS remaining FROM customers WHERE company_id = $1 AND is_archived = false`,
        [companyId],
      );

      this.logger.log(
        `Clientes vaciados (company ${companyId}): ${deleted} borrados, ${archived} archivados.`,
      );
      return { deleted, archived, remaining: Number(remaining) };
    });
  }

  /**
   * Separa los clientes de la company en borrables y protegidos. Incluye los ya
   * archivados: si no tienen historial también se borran (limpieza), y si lo
   * tienen simplemente siguen archivados.
   */
  private async classify(
    manager: EntityManager,
    companyId: number,
  ): Promise<{ deletableIds: string[]; protectedIds: string[] }> {
    const rows = await manager.query<{ id: string; protected: boolean; is_archived: boolean }[]>(
      `
      ${CUSTOMER_PROTECTION_CTE}
      SELECT id, protected, is_archived
      FROM protection
      `,
      [companyId],
    );

    return {
      deletableIds: rows.filter((r) => !r.protected).map((r) => r.id),
      // Los ya archivados no se vuelven a tocar (nada que cambiar).
      protectedIds: rows.filter((r) => r.protected && !r.is_archived).map((r) => r.id),
    };
  }

  /** Archiva los protegidos: salen de la lista viva sin perder su historia. */
  private async archive(manager: EntityManager, ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await manager.query<unknown[]>(
      `UPDATE customers
          SET is_archived = true,
              updated_at = now()
        WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    // `query` de un UPDATE devuelve [rows, affected]; TypeORM expone el conteo aparte.
    return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : ids.length;
  }

  /**
   * Borra los clientes sin historial. Ninguna tabla los referencia (por eso
   * están en `deletableIds`), así que un solo DELETE basta.
   */
  private async deleteCustomers(manager: EntityManager, ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const removed = await manager.query<{ id: string }[]>(
      `DELETE FROM customers WHERE id = ANY($1::bigint[]) RETURNING id`,
      [ids],
    );
    return removed.length;
  }
}
