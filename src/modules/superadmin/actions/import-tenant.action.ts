import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

import { resyncTicketCounters } from '@/modules/ticket-settings/internal/resync-ticket-counters';
import { ProductImagesService } from '@/modules/product-images/product-images.service';

import {
  BackupRow,
  ImportRemapContext,
  ImportResult,
  ImportTableResult,
  TENANT_BACKUP_FORMAT,
  TENANT_BACKUP_VERSION,
  TenantBackup,
  computeTablesHash,
  getForeignKeyColumns,
  getForeignKeyEdges,
  getJsonColumns,
  getPrimaryKeyColumns,
  getSelfReferenceColumns,
  partitionImportTables,
  quoteIdent,
  remapRowForImport,
  sortSelfReferential,
  topoSortTables,
} from '../tenant-backup/tenant-backup.util';

interface OwnerInfo {
  id: number;
  name: string | null;
}

/**
 * Importa un respaldo generado por `ExportTenantAction` REEMPLAZANDO por completo
 * la data de una company destino. A diferencia de una restauración a la misma
 * cuenta, aquí el respaldo puede venir de OTRA empresa (p.ej. importar "Esencia &
 * Grano" dentro de "El Surtidor"): se limpia toda la data de negocio del destino
 * y se reemplaza con la del origen. Ver [[project_tenant_backup_export_import]].
 *
 * Flujo (todo en UNA transacción; si algo falla, el destino queda intacto):
 *
 *  1. Valida formato/versión y el hash sha256 anti-alteración (400 si no cuadra).
 *     NO exige que el respaldo sea de esta company (ese es justo el objetivo).
 *  2. Clasifica las tablas: se CONSERVAN identidad/acceso/config del destino
 *     (companies, users, employees, roles, suscripción, settings…), se IGNORA
 *     `inventory_shares`, y se REEMPLAZA todo lo demás.
 *  3. LIMPIA la data reemplazable del destino en orden topológico inverso
 *     (hijos antes que padres) para no violar FKs.
 *  4. INSERTA las filas del origen en orden topológico (padres primero), con
 *     ids NUEVOS asignados por la BD (los ids del respaldo son globales y
 *     colisionarían con otras companies). Cada FK se remapea: `company_id` →
 *     destino, referencias a usuarios → owner del destino, y FKs internas → el
 *     nuevo id del padre. Cada fila va bajo SAVEPOINT: una FK insatisfacible
 *     descarta esa fila (skipped) sin abortar.
 *
 * Devuelve cuántas filas se borraron, insertaron y saltaron (total y por tabla).
 */
@Injectable()
export class ImportTenantAction {
  private readonly logger = new Logger(ImportTenantAction.name);

  /**
   * Tablas "una por usuario" (índice único parcial `(company_id, user_id)`) que,
   * al colapsar TODOS los usuarios del origen en el ÚNICO owner del destino,
   * colisionarían entre sí. Se FUSIONAN en una sola fila del owner sumando sus
   * columnas numéricas (Big.js) y reapuntando sus hijos (p.ej.
   * `cash_register_logs`) a esa fila única. `cash_registers` es hoy el único
   * caso: cada usuario tiene una caja con saldo propio; el destino queda con una
   * sola caja del owner cuyo saldo es la suma de las del origen.
   */
  private static readonly MERGE_INTO_OWNER: Record<string, string[]> = {
    cash_registers: ['balance', 'base_amount'],
  };

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly productImages: ProductImagesService,
  ) {}

  async execute(companyId: number, backup: TenantBackup): Promise<ImportResult> {
    this.validateShape(backup);

    // Anti-alteración: el hash recalculado debe coincidir con el del manifiesto.
    const recomputed = computeTablesHash(backup.tables);
    if (recomputed !== backup.meta.hash) {
      throw new BadRequestException(
        'El respaldo fue alterado o está corrupto: el hash de integridad no coincide.',
      );
    }

    // El destino debe existir (no se importa sobre una company inexistente).
    const target = await this.dataSource.query<Array<{ id: number }>>(
      `SELECT id FROM companies WHERE id = $1`,
      [companyId],
    );
    if (!target.length) {
      throw new BadRequestException(`La company destino ${companyId} no existe.`);
    }

    const present = Object.keys(backup.tables);
    const { replace } = partitionImportTables(present);

    const q = this.dataSource.query.bind(this.dataSource);
    const [edges, selfRefs, jsonCols, fkColumns, pkColumns, owner] = await Promise.all([
      getForeignKeyEdges(q, replace),
      getSelfReferenceColumns(q, replace),
      getJsonColumns(q, replace),
      getForeignKeyColumns(q, replace),
      getPrimaryKeyColumns(q, replace),
      this.resolveOwner(companyId),
    ]);
    const order = topoSortTables(replace, edges);

    // tabla padre → (id viejo del respaldo → id nuevo asignado por la BD).
    const idMaps = new Map<string, Map<string, number>>(replace.map((t) => [t, new Map()]));

    const perTable = new Map<string, ImportTableResult>(
      replace.map((t) => [t, { table: t, deleted: 0, inserted: 0, skipped: 0 }]),
    );

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      // 1) LIMPIEZA: borra la data reemplazable del destino (hijos → padres).
      for (const table of [...order].reverse()) {
        const companyCols = this.companyColumnsOf(table, fkColumns);
        if (companyCols.length === 0) {
          continue; // sin columna de company: no se sabe qué borrar, se omite.
        }
        const where = companyCols.map((c) => `${quoteIdent(c)} = $1`).join(' OR ');
        const res = await runner.query(
          `DELETE FROM ${quoteIdent(table)} WHERE ${where}`,
          [companyId],
          true,
        );
        const entry = perTable.get(table);
        if (entry) {
          entry.deleted = res.affected ?? 0;
        }
      }

      // 2) INSERCIÓN: filas del origen con ids nuevos (padres → hijos).
      for (const table of order) {
        let rows = backup.tables[table] ?? [];
        if (rows.length === 0) {
          continue;
        }

        const selfRefCol = selfRefs[table];
        if (selfRefCol) {
          rows = sortSelfReferential(rows, selfRefCol);
        }

        const ctx: ImportRemapContext = {
          targetCompanyId: companyId,
          ownerUserId: owner?.id ?? null,
          ownerName: owner?.name ?? null,
          pkColumn: pkColumns[table] ?? null,
          fkParentByColumn: fkColumns[table] ?? {},
          jsonColumns: jsonCols[table] ?? new Set<string>(),
          idMaps,
        };

        const entry = perTable.get(table);
        const map = idMaps.get(table);

        // Tablas "una por usuario": todas las filas del origen se funden en una
        // sola del owner del destino (saldos sumados) y sus hijos apuntan a ella.
        const sumCols = ImportTenantAction.MERGE_INTO_OWNER[table];
        if (sumCols && ctx.pkColumn) {
          const merged = this.mergeRows(rows, sumCols);
          const newId = await this.insertRow(runner, table, merged, ctx);
          if (newId === null) {
            if (entry) {
              entry.skipped += rows.length;
            }
          } else {
            if (entry) {
              entry.inserted += 1;
            }
            if (map) {
              for (const row of rows) {
                const oldId = row[ctx.pkColumn];
                if (oldId !== null && oldId !== undefined) {
                  map.set(String(oldId), newId);
                }
              }
            }
          }
          continue;
        }

        for (const row of rows) {
          const oldId = ctx.pkColumn ? row[ctx.pkColumn] : undefined;
          const newId = await this.insertRow(runner, table, row, ctx);
          if (newId === null) {
            if (entry) {
              entry.skipped += 1;
            }
            continue;
          }
          if (entry) {
            entry.inserted += 1;
          }
          if (map && ctx.pkColumn && oldId !== null && oldId !== undefined) {
            map.set(String(oldId), newId);
          }
        }
      }

      // 3) RESINCRONIZACIÓN DE FOLIOS: `ticket_settings` está en
      //    `PRESERVED_TABLES` (el prefix/suffix del destino debe sobrevivir),
      //    pero las ventas/notas/compras que acabamos de insertar traen los
      //    folios del ORIGEN. Sin esto el contador del destino queda por detrás
      //    y la siguiente venta choca contra el UNIQUE de `ticket_number`
      //    dejando el POS bloqueado (el rollback deshace el incremento, así que
      //    reintentar pide el mismo folio ocupado). Ver
      //    [[project_tenant_backup_export_import]].
      const resynced = await resyncTicketCounters(runner.manager, companyId);
      if (resynced.length > 0) {
        this.logger.log({
          event: 'superadmin.tenant.import.counters_resynced',
          targetCompanyId: companyId,
          counters: resynced.map((c) => `${c.ticket_type}=${c.current_number}`),
        });
      }

      await runner.commitTransaction();
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }

    const list = order.map((t) => perTable.get(t)!).filter(Boolean);
    const deleted = list.reduce((a, t) => a + t.deleted, 0);
    const inserted = list.reduce((a, t) => a + t.inserted, 0);
    const skipped = list.reduce((a, t) => a + t.skipped, 0);

    this.logger.log({
      event: 'superadmin.tenant.import',
      targetCompanyId: companyId,
      sourceCompanyId: backup.meta.companyId,
      deleted,
      inserted,
      skipped,
    });

    // Los productos del DESTINO se borraron para dar paso a los del origen: sus
    // imágenes se quedaron sin nadie que las referenciara. Las del origen NO se
    // copian (la columna `image` se anula al importar, ver BUCKET_PATH_COLUMNS),
    // así que la carpeta del destino queda vacía y limpia.
    await this.productImages.removeAllForCompany(companyId);

    return {
      targetCompanyId: companyId,
      sourceCompanyId: backup.meta.companyId,
      sourceCompanyName: backup.meta.companyName,
      deleted,
      inserted,
      skipped,
      perTable: list,
    };
  }

  // ------------------------------------------------------------------------

  private validateShape(backup: TenantBackup): void {
    if (
      !backup ||
      backup.format !== TENANT_BACKUP_FORMAT ||
      backup.version !== TENANT_BACKUP_VERSION ||
      typeof backup.meta !== 'object' ||
      typeof backup.meta?.hash !== 'string' ||
      typeof backup.tables !== 'object' ||
      backup.tables === null
    ) {
      throw new BadRequestException('El archivo no es un respaldo válido de kdevs.');
    }
  }

  /** Owner (type='owner') del destino: id + nombre para el remapeo de auditoría. */
  private async resolveOwner(companyId: number): Promise<OwnerInfo | null> {
    const rows = await this.dataSource.query<Array<{ id: number; name: string | null }>>(
      `SELECT id, NULLIF(TRIM(CONCAT_WS(' ', name, lastname)), '') AS name
         FROM users
        WHERE company_id = $1 AND type = 'owner'
        ORDER BY id
        LIMIT 1`,
      [companyId],
    );
    return rows[0] ?? null;
  }

  /**
   * Funde N filas en una sola: toma la primera como plantilla y reemplaza las
   * columnas numéricas indicadas por la SUMA (Big.js, escala monetaria) de todas
   * las filas. El resto de columnas (incluida la referencia a usuario, que el
   * remapeo reapunta al owner) se toman de la plantilla.
   */
  private mergeRows(rows: BackupRow[], sumColumns: string[]): BackupRow {
    const merged: BackupRow = { ...rows[0] };
    for (const col of sumColumns) {
      let acc = toBig(0);
      for (const r of rows) {
        acc = acc.plus(toBig(r[col]));
      }
      merged[col] = preciseNumber(acc, 2);
    }
    return merged;
  }

  /** Columnas de esta tabla que apuntan a `companies` (para filtrar el DELETE). */
  private companyColumnsOf(
    table: string,
    fkColumns: Record<string, Record<string, string>>,
  ): string[] {
    const cols = fkColumns[table] ?? {};
    return Object.keys(cols).filter((c) => cols[c] === 'companies');
  }

  /**
   * Inserta una fila remapeada bajo un SAVEPOINT y devuelve el nuevo id (o `null`
   * si se descartó por FK insatisfacible / columna faltante).
   */
  private async insertRow(
    runner: QueryRunner,
    table: string,
    row: BackupRow,
    ctx: ImportRemapContext,
  ): Promise<number | null> {
    const { columns, values } = remapRowForImport(row, ctx);
    if (columns.length === 0) {
      return null;
    }
    const tableIdent = quoteIdent(table);
    const colList = columns.map(quoteIdent).join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const returning = ctx.pkColumn ? ` RETURNING ${quoteIdent(ctx.pkColumn)} AS __newid` : '';
    const sql = `INSERT INTO ${tableIdent} (${colList}) VALUES (${placeholders})${returning}`;

    await runner.query('SAVEPOINT row_sp');
    try {
      const res = (await runner.query(sql, values)) as Array<{ __newid: number }>;
      await runner.query('RELEASE SAVEPOINT row_sp');
      return ctx.pkColumn ? (res[0]?.__newid ?? null) : 0;
    } catch (err) {
      await runner.query('ROLLBACK TO SAVEPOINT row_sp');
      this.logger.warn({
        event: 'superadmin.tenant.import.row_skipped',
        table,
        rowId: (ctx.pkColumn ? row[ctx.pkColumn] : null) ?? null,
        reason: (err as Error).message,
      });
      return null;
    }
  }
}
