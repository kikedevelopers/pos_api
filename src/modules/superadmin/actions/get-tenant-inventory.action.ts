import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

import { PRODUCT_TREE_CTE, PRODUCT_PROTECTION_CTE } from './tenant-inventory.sql';

export interface TenantInventorySummary {
  /** Productos activos (no archivados). Es "la cantidad de productos" del cliente. */
  active: number;
  /** Productos base (sin padre) y presentaciones, dentro de los activos. */
  bases: number;
  presentations: number;
  /** Ya archivados: no cuentan como inventario vivo, pero siguen en la tabla. */
  archived: number;
  /**
   * Qué pasaría al vaciar el inventario. `deletable` incluye los ya archivados
   * sin historial (también se limpian); `protectable` son los activos que se
   * archivarían por tener historial de negocio su árbol. Ver
   * `clear-tenant-inventory` para la definición exacta de "protegido".
   */
  deletable: number;
  protectable: number;
  /** Valor del inventario activo a costo (stock × costo). */
  stockValue: number;
  /** Catálogo asociado, que NO se toca al vaciar el inventario. */
  categories: number;
  packagings: number;
}

interface SummaryRow {
  active: string;
  bases: string;
  presentations: string;
  archived: string;
  deletable: string;
  protectable: string;
  stock_value: string;
  categories: string;
  packagings: string;
}

/**
 * Resumen del inventario de un tenant para el panel superadmin: cuántos
 * productos tiene y qué pasaría si se vacía. Solo lectura.
 */
@Injectable()
export class GetTenantInventoryAction {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number): Promise<TenantInventorySummary> {
    const company = await this.dataSource
      .getRepository(Company)
      .findOne({ where: { id: String(companyId) } });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} no existe.`);
    }

    const [row] = await this.dataSource.query<SummaryRow[]>(
      `
      ${PRODUCT_TREE_CTE},
      ${PRODUCT_PROTECTION_CTE}
      SELECT
        count(*) FILTER (WHERE NOT p.is_archived)                                  AS active,
        count(*) FILTER (WHERE NOT p.is_archived AND p.parent_id IS NULL)          AS bases,
        count(*) FILTER (WHERE NOT p.is_archived AND p.parent_id IS NOT NULL)      AS presentations,
        count(*) FILTER (WHERE p.is_archived)                                      AS archived,
        count(*) FILTER (WHERE NOT pr.protected)                                   AS deletable,
        count(*) FILTER (WHERE NOT p.is_archived AND pr.protected)                 AS protectable,
        coalesce(sum(p.stock * p.cost) FILTER (WHERE NOT p.is_archived), 0)        AS stock_value,
        (SELECT count(*) FROM categories c
          WHERE c.company_id = $1 AND c.is_archived = false)                       AS categories,
        (SELECT count(*) FROM packagings pk
          WHERE pk.company_id = $1 AND pk.is_archived = false)                     AS packagings
      FROM prod p
      JOIN protection pr ON pr.id = p.id
      `,
      [companyId],
    );

    return {
      active: Number(row?.active ?? 0),
      bases: Number(row?.bases ?? 0),
      presentations: Number(row?.presentations ?? 0),
      archived: Number(row?.archived ?? 0),
      deletable: Number(row?.deletable ?? 0),
      protectable: Number(row?.protectable ?? 0),
      stockValue: Number(row?.stock_value ?? 0),
      categories: Number(row?.categories ?? 0),
      packagings: Number(row?.packagings ?? 0),
    };
  }
}
