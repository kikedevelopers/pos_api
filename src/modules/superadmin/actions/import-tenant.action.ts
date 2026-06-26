import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import {
  BackupRow,
  ImportResult,
  ImportTableResult,
  TENANT_BACKUP_FORMAT,
  TENANT_BACKUP_VERSION,
  TenantBackup,
  computeTablesHash,
  getForeignKeyEdges,
  getJsonColumns,
  getSelfReferenceColumns,
  quoteIdent,
  serializeValue,
  sortSelfReferential,
  topoSortTables,
} from '../tenant-backup/tenant-backup.util';

/**
 * Importa un respaldo generado por `ExportTenantAction`. Flujo:
 *
 *  1. Valida formato/versión y que el respaldo corresponde a esta company.
 *  2. Recalcula el hash sha256 de los datos y lo compara con el del manifiesto:
 *     si no coincide, el `.zip` fue alterado/corrompido → 400 (no se inserta
 *     nada).
 *  3. Inserta en orden topológico (cada padre antes que sus hijos) dentro de UNA
 *     transacción. Cada fila va con `ON CONFLICT DO NOTHING`: si ya existe (por
 *     PK o cualquier índice único) se IGNORA; si no, se INSERTA con su id
 *     original (se preservan todas las relaciones).
 *  4. Cada fila se inserta bajo un SAVEPOINT: si viola una FK que no puede
 *     satisfacerse (p.ej. `inventory_shares` hacia otra company que no está en
 *     el respaldo) se descarta esa fila (skipped) sin abortar el resto.
 *  5. Reajusta las secuencias de `id` al máximo insertado.
 *
 * Devuelve cuántas filas se insertaron, se ignoraron y se saltaron (total y por
 * tabla).
 */
@Injectable()
export class ImportTenantAction {
  private readonly logger = new Logger(ImportTenantAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number, backup: TenantBackup): Promise<ImportResult> {
    this.validateShape(backup);

    if (backup.meta.companyId !== companyId) {
      throw new BadRequestException(
        `El respaldo pertenece a la company ${backup.meta.companyId}, no a la ${companyId}.`,
      );
    }

    // Anti-alteración: el hash recalculado debe coincidir con el del manifiesto.
    const recomputed = computeTablesHash(backup.tables);
    if (recomputed !== backup.meta.hash) {
      throw new BadRequestException(
        'El respaldo fue alterado o está corrupto: el hash de integridad no coincide.',
      );
    }

    const present = Object.keys(backup.tables);
    const q = this.dataSource.query.bind(this.dataSource);
    const [edges, selfRefs, jsonCols] = await Promise.all([
      getForeignKeyEdges(q, present),
      getSelfReferenceColumns(q, present),
      getJsonColumns(q, present),
    ]);
    const order = topoSortTables(present, edges);

    const perTable: ImportTableResult[] = [];
    let inserted = 0;
    let ignored = 0;
    let skipped = 0;

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      for (const table of order) {
        let rows = backup.tables[table] ?? [];
        if (rows.length === 0) {
          perTable.push({ table, inserted: 0, ignored: 0, skipped: 0 });
          continue;
        }
        const selfRefCol = selfRefs[table];
        if (selfRefCol) {
          rows = sortSelfReferential(rows, selfRefCol);
        }

        const jsonSet = jsonCols[table] ?? new Set<string>();
        const result = await this.insertRows(runner, table, rows, jsonSet);
        perTable.push({ table, ...result });
        inserted += result.inserted;
        ignored += result.ignored;
        skipped += result.skipped;
      }

      await this.resetSequences(runner, order);
      await runner.commitTransaction();
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }

    this.logger.log({
      event: 'superadmin.tenant.import',
      companyId,
      inserted,
      ignored,
      skipped,
    });

    return { companyId, inserted, ignored, skipped, perTable };
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

  /**
   * Inserta las filas de una tabla, fila por fila bajo un SAVEPOINT. Usa
   * `RETURNING 1` para distinguir insertado (1 fila) de ignorado por conflicto
   * (0 filas). Un error de FK descarta solo esa fila (skipped).
   */
  private async insertRows(
    runner: QueryRunner,
    table: string,
    rows: BackupRow[],
    jsonCols: Set<string>,
  ): Promise<{ inserted: number; ignored: number; skipped: number }> {
    let inserted = 0;
    let ignored = 0;
    let skipped = 0;
    const tableIdent = quoteIdent(table);

    for (const row of rows) {
      const columns = Object.keys(row);
      if (columns.length === 0) {
        skipped += 1;
        continue;
      }
      const colList = columns.map(quoteIdent).join(', ');
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const values = columns.map((c) => serializeValue(row[c], jsonCols.has(c)));
      const sql = `INSERT INTO ${tableIdent} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING RETURNING 1`;

      await runner.query('SAVEPOINT row_sp');
      try {
        const res = (await runner.query(sql, values)) as unknown[];
        if (Array.isArray(res) && res.length > 0) {
          inserted += 1;
        } else {
          ignored += 1;
        }
        await runner.query('RELEASE SAVEPOINT row_sp');
      } catch (err) {
        await runner.query('ROLLBACK TO SAVEPOINT row_sp');
        skipped += 1;
        this.logger.warn({
          event: 'superadmin.tenant.import.row_skipped',
          table,
          rowId: row.id ?? null,
          reason: (err as Error).message,
        });
      }
    }

    return { inserted, ignored, skipped };
  }

  /**
   * Reajusta la secuencia de `id` de cada tabla al máximo id presente, para que
   * los próximos INSERT del cliente no colisionen con los ids restaurados.
   * Best-effort: una tabla sin secuencia serial se ignora en silencio.
   */
  private async resetSequences(runner: QueryRunner, tables: string[]): Promise<void> {
    for (const table of tables) {
      try {
        const seqRows = (await runner.query(`SELECT pg_get_serial_sequence($1, 'id') AS seq`, [
          table,
        ])) as Array<{ seq: string | null }>;
        const seq = seqRows[0]?.seq;
        if (!seq) {
          continue;
        }
        await runner.query(
          `SELECT setval($1, GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${quoteIdent(table)}), 1))`,
          [seq],
        );
      } catch (err) {
        this.logger.warn({
          event: 'superadmin.tenant.import.seq_reset_failed',
          table,
          reason: (err as Error).message,
        });
      }
    }
  }
}
