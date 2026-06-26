import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  BackupRow,
  TENANT_BACKUP_FORMAT,
  TENANT_BACKUP_VERSION,
  TenantBackup,
  computeTablesHash,
  getCompanyScopedTables,
  quoteIdent,
} from '../tenant-backup/tenant-backup.util';

/**
 * Exporta un respaldo COMPLETO de un tenant (una company): la fila de la
 * `companies` + TODAS las filas de TODAS las tablas con scoping por
 * `company_id`, descubiertas dinámicamente del catálogo. Si mañana se crea una
 * tabla nueva con su FK a `companies`, entra sola en el respaldo sin tocar este
 * código.
 *
 * El resultado es un snapshot JSON con un `hash` sha256 de los datos
 * (anti-alteración) que el IMPORT recalcula y verifica. El panel kdevs-admin
 * empaqueta este snapshot en un `.zip` (un JSON por tabla) para descargar.
 *
 * Read puro pero envuelto en una transacción REPEATABLE READ: garantiza un
 * snapshot consistente de todas las tablas (sin filas a medio escribir entre
 * SELECTs).
 */
@Injectable()
export class ExportTenantAction {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number): Promise<TenantBackup> {
    const company = await this.dataSource.query<Array<{ name: string }>>(
      `SELECT name FROM companies WHERE id = $1`,
      [companyId],
    );
    if (!company.length) {
      throw new NotFoundException(`Company ${companyId} no existe.`);
    }

    const tables: Record<string, BackupRow[]> = {};
    let rowCount = 0;

    await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const q = manager.query.bind(manager);

      // La company misma (raíz de todo el grafo) va primero.
      tables.companies = await q<BackupRow[]>(`SELECT * FROM companies WHERE id = $1`, [companyId]);
      rowCount += tables.companies.length;

      const scoped = await getCompanyScopedTables(q);
      for (const { table, companyColumns } of scoped) {
        const where = companyColumns.map((c) => `${quoteIdent(c)} = $1`).join(' OR ');
        const rows = await q<BackupRow[]>(
          `SELECT * FROM ${quoteIdent(table)} WHERE ${where} ORDER BY id`,
          [companyId],
        );
        tables[table] = rows;
        rowCount += rows.length;
      }
    });

    const hash = computeTablesHash(tables);

    return {
      format: TENANT_BACKUP_FORMAT,
      version: TENANT_BACKUP_VERSION,
      meta: {
        companyId,
        companyName: company[0].name,
        generatedAt: new Date().toISOString(),
        tableCount: Object.keys(tables).length,
        rowCount,
        hash,
      },
      tables,
    };
  }
}
