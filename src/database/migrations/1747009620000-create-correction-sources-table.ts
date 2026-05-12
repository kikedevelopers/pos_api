import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 7 — Crea la tabla `correction_sources`.
 *
 * Espejo de `placepos/src/main/database/entities/CorrectionSource.ts`.
 *
 * --------------------------------------------------------------------------
 * Propósito
 * --------------------------------------------------------------------------
 *
 *   Cuando una `CreditNote` (típicamente FULL_VOID / PARTIAL_VOID) genera
 *   una devolución de dinero, registramos de qué cuenta sale el monto. Por
 *   ejemplo:
 *
 *     - FULL_VOID de una venta pagada con TRANSFER → la nota referencia el
 *       Bank desde el que se devuelve. `source_type='bank'`,
 *       `source_id=bank.id`, `source_name=bank.name`.
 *
 *     - FULL_VOID de una venta pagada con CASH (caja abierta) → la nota
 *       referencia la caja. `source_type='cash_register'`,
 *       `source_id=cash_register.id`, `source_name='Caja {fecha}'`.
 *
 *   PlacePos guarda esta info como rastro de auditoría — los reportes
 *   financieros la usan para cruzar movimientos.
 *
 *   Relación 1:1 con CreditNote (UNIQUE `credit_note_id`): cada nota tiene a
 *   lo sumo UNA fuente de corrección. Cuando una nota no genera retorno de
 *   dinero (PARTIAL_VOID que solo ajusta el crédito del cliente, ADDITION
 *   que solo aumenta deuda), NO se crea row.
 */
export class CreateCorrectionSourcesTable1747009620000 implements MigrationInterface {
  name = 'CreateCorrectionSourcesTable1747009620000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'correction_sources',
        columns: [
          {
            name: 'id',
            type: 'bigserial',
            isPrimary: true,
          },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Tenant al que pertenece. Asignado por el service desde req.user.company_id.',
          },
          {
            name: 'credit_note_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Nota que originó la corrección. UNIQUE — máximo una fuente por nota.',
          },
          {
            name: 'source_type',
            type: 'text',
            isNullable: false,
            comment: `'bank' | 'wallet' | 'cash_register' | 'sale_credit'.`,
          },
          {
            name: 'source_id',
            type: 'bigint',
            isNullable: false,
            comment: 'ID de la cuenta/credit referenciado. Sin FK formal — el tipo varía.',
          },
          {
            name: 'source_name',
            type: 'text',
            isNullable: false,
            comment: 'Snapshot del nombre legible (ej. "Banco Mercantil", "Caja Tarde").',
          },
          {
            name: 'created_by',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'created_by_id',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
        checks: [
          {
            name: 'chk_correction_sources_source_type_values',
            expression: `source_type IN ('bank', 'wallet', 'cash_register', 'sale_credit')`,
          },
          {
            name: 'chk_correction_sources_source_name_not_empty',
            expression: 'length(btrim(source_name)) > 0',
          },
        ],
      }),
      true,
    );

    // FK a companies.
    await queryRunner.createForeignKey(
      'correction_sources',
      new TableForeignKey({
        name: 'fk_correction_sources_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // FK a credit_notes. CASCADE — si la nota se borra físicamente, su fuente
    // se borra también. En práctica la nota se soft-deletea.
    await queryRunner.createForeignKey(
      'correction_sources',
      new TableForeignKey({
        name: 'fk_correction_sources_credit_note_id',
        columnNames: ['credit_note_id'],
        referencedTableName: 'credit_notes',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    // Índices.
    // a) UNIQUE per-company (company_id, credit_note_id) — relación 1:1.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_correction_sources_company_credit_note_unique
      ON correction_sources (company_id, credit_note_id)
    `);

    // b) (company_id, source_type, source_id) — buscar todas las correcciones
    //    que afectaron a una cuenta dada (reporte de devoluciones por banco).
    await queryRunner.createIndex(
      'correction_sources',
      new TableIndex({
        name: 'idx_correction_sources_company_source',
        columnNames: ['company_id', 'source_type', 'source_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('correction_sources', 'idx_correction_sources_company_source');
    await queryRunner.query(
      'DROP INDEX IF EXISTS idx_correction_sources_company_credit_note_unique',
    );
    await queryRunner.dropForeignKey('correction_sources', 'fk_correction_sources_credit_note_id');
    await queryRunner.dropForeignKey('correction_sources', 'fk_correction_sources_company_id');
    await queryRunner.dropTable('correction_sources');
  }
}
