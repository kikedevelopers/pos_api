import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import { PersonType } from '@/modules/customers/entities/customer.entity';

/**
 * Una fila exportable de cliente. Solo los campos PORTABLES entre negocios:
 * los que describen al cliente, no su estado de negocio en una company
 * concreta (saldo, puntos, anticipos, archivado, auditoría, ids). La categoría
 * viaja por NOMBRE, no por id: los ids de `customer_categories` son locales a
 * cada company; al importar se resuelve/crea por nombre en el destino.
 */
export interface TenantCustomerExportRow {
  person_type: PersonType;
  name: string;
  doc_number: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  /** Nombre de la categoría especial del cliente. `null` si no tiene. */
  category: string | null;
}

export interface TenantCustomersExport {
  companyId: number;
  companyName: string;
  /** Clientes ACTIVOS (no archivados), ordenados por nombre. */
  customers: TenantCustomerExportRow[];
}

interface ExportRow {
  person_type: PersonType;
  name: string;
  doc_number: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  category: string | null;
}

/**
 * Exporta la lista de clientes ACTIVOS de un tenant para descargarla como CSV
 * desde el panel y volver a cargarla en otro negocio o sucursal. Solo lectura.
 *
 * Exporta únicamente los activos a propósito: es "la lista que el cliente ve".
 * Los archivados tienen historial de negocio y no son parte de un volcado de
 * datos portable.
 */
@Injectable()
export class ExportTenantCustomersAction {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number): Promise<TenantCustomersExport> {
    const company = await this.dataSource
      .getRepository(Company)
      .findOne({ where: { id: String(companyId) } });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} no existe.`);
    }

    const rows = await this.dataSource.query<ExportRow[]>(
      `
      SELECT c.person_type,
             c.name,
             c.doc_number,
             c.phone,
             c.email,
             c.address,
             cc.name AS category
      FROM customers c
      LEFT JOIN customer_categories cc ON cc.id = c.category_id
      WHERE c.company_id = $1
        AND c.is_archived = false
      ORDER BY lower(btrim(c.name)) ASC, c.id ASC
      `,
      [companyId],
    );

    return {
      companyId,
      companyName: company.name,
      customers: rows.map((r) => ({
        person_type: r.person_type,
        name: r.name,
        doc_number: r.doc_number,
        phone: r.phone,
        email: r.email,
        address: r.address,
        category: r.category,
      })),
    };
  }
}
