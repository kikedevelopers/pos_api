import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

import { CUSTOMER_PROTECTION_CTE } from './tenant-customers.sql';

export interface TenantCustomersSummary {
  /** Clientes activos (no archivados). Es "la cantidad de clientes" del cliente. */
  active: number;
  /** Ya archivados: no cuentan como lista viva, pero siguen en la tabla. */
  archived: number;
  /**
   * Qué pasaría al vaciar la lista. `deletable` incluye los ya archivados sin
   * historial (también se limpian); `protectable` son los activos que se
   * archivarían por tener historial de negocio. Ver `clear-tenant-customers`
   * para la definición exacta de "protegido".
   */
  deletable: number;
  protectable: number;
}

interface SummaryRow {
  active: string;
  archived: string;
  deletable: string;
  protectable: string;
}

/**
 * Resumen de los clientes de un tenant para el panel superadmin: cuántos tiene
 * y qué pasaría si se vacía la lista completa. Solo lectura.
 */
@Injectable()
export class GetTenantCustomersAction {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number): Promise<TenantCustomersSummary> {
    const company = await this.dataSource
      .getRepository(Company)
      .findOne({ where: { id: String(companyId) } });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} no existe.`);
    }

    const [row] = await this.dataSource.query<SummaryRow[]>(
      `
      ${CUSTOMER_PROTECTION_CTE}
      SELECT
        count(*) FILTER (WHERE NOT is_archived)                  AS active,
        count(*) FILTER (WHERE is_archived)                      AS archived,
        count(*) FILTER (WHERE NOT protected)                    AS deletable,
        count(*) FILTER (WHERE NOT is_archived AND protected)    AS protectable
      FROM protection
      `,
      [companyId],
    );

    return {
      active: Number(row?.active ?? 0),
      archived: Number(row?.archived ?? 0),
      deletable: Number(row?.deletable ?? 0),
      protectable: Number(row?.protectable ?? 0),
    };
  }
}
