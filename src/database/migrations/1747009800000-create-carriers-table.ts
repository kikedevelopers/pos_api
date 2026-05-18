import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 2A — Crea la tabla `carriers`.
 *
 * Contexto del dominio:
 *
 *   `Carrier` = transportista al que se le pagan fletes/portes. PlacePos
 *   modela un endpoint `/carriers/analytics` para KPI (deuda total, pagos
 *   del día) y un `PUT /:id/archive` con validación 422 si tiene deuda
 *   pendiente.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 *   `company_id bigint NOT NULL` + FK + índice. UNIQUE parcial per-company
 *   sobre `lower(btrim(name))` para activos (reúsa el nombre al archivar).
 *
 * --------------------------------------------------------------------------
 * `carrier_credits` (tabla independiente, ver migración 1747009860000)
 * --------------------------------------------------------------------------
 *
 *   La deuda pendiente NO se almacena en `carriers` — se calcula como
 *   `SUM(carrier_credits.balance) WHERE balance > 0` per-carrier. Mantener
 *   el agregado en una sola tabla evita drift entre el campo cacheado y la
 *   suma real (lecciones aprendidas del modelo PlacePos).
 */
export class CreateCarriersTable1747009800000 implements MigrationInterface {
  name = 'CreateCarriersTable1747009800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'carriers',
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
            comment: 'Tenant al que pertenece el carrier. Asignado desde req.user.company_id.',
          },
          {
            name: 'name',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'identification',
            type: 'text',
            isNullable: true,
            comment: 'Documento fiscal del transportista (RIF/NIT/CUIT/RFC).',
          },
          {
            name: 'phone',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'email',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'notes',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
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
          {
            name: 'updated_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
        checks: [
          {
            name: 'chk_carriers_name_not_empty',
            expression: 'length(btrim(name)) > 0',
          },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'carriers',
      new TableForeignKey({
        name: 'fk_carriers_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'carriers',
      new TableIndex({
        name: 'idx_carriers_company_id',
        columnNames: ['company_id'],
      }),
    );

    // UNIQUE parcial per-company sobre `lower(btrim(name))` para activos.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_carriers_company_name_unique
      ON carriers (company_id, lower(btrim(name)))
      WHERE is_archived = false
    `);

    // Índice compuesto para listados activos por fecha (analytics).
    await queryRunner.query(`
      CREATE INDEX idx_carriers_company_active
      ON carriers (company_id, created_at DESC)
      WHERE is_archived = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_carriers_company_active');
    await queryRunner.query('DROP INDEX IF EXISTS idx_carriers_company_name_unique');
    await queryRunner.dropIndex('carriers', 'idx_carriers_company_id');
    await queryRunner.dropForeignKey('carriers', 'fk_carriers_company_id');
    await queryRunner.dropTable('carriers');
  }
}
