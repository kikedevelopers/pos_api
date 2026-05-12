import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 10 — Crea la tabla `alert_configs`.
 *
 * Espejo de `AlertConfig.ts` PlacePos con dos cambios:
 *
 *   - `company_id` NOT NULL con FK a `companies`.
 *   - UNIQUE `(company_id, type)` — el PlacePos local usa UNIQUE GLOBAL en
 *     `alert_type`, aquí lo hacemos per-company para que dos tenants
 *     configuren su propio threshold sin colisionar.
 *
 *   - `enabled` (bool default true) — PlacePos llama al campo `is_enabled`;
 *     la fase indica `enabled` así que mantenemos el nombre del spec. Es la
 *     única divergencia léxica; aceptada porque PlacePos local no consume
 *     este endpoint cloud directamente (los evaluators internos viven
 *     local).
 *
 *   - `threshold` numeric NULL — espacio para "stock < N", "porcentaje < N%",
 *     etc. La forma del `config jsonb` define cómo se interpreta.
 *
 *   - `config jsonb default '{}'` — params específicos del evaluator. Los
 *     evaluators viven en Fase 11; aquí solo persistimos el blob.
 *
 *   - NO incluimos `check_time` / `last_run_at` por ahora — son del
 *     scheduler de PlacePos local que no se migra al cloud (los crons
 *     correrán como jobs externos en Fase 11).
 */
export class CreateAlertConfigsTable1747009200000 implements MigrationInterface {
  name = 'CreateAlertConfigsTable1747009200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'alert_configs',
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
            comment: 'Tenant al que pertenece la configuración. Asignado por el service desde JWT.',
          },
          {
            name: 'type',
            type: 'varchar',
            length: '50',
            isNullable: false,
            comment:
              'Identificador del tipo de alerta (string-enum: low_stock, break_even, inactive_customer, etc.).',
          },
          {
            name: 'enabled',
            type: 'boolean',
            isNullable: false,
            default: true,
          },
          {
            name: 'threshold',
            type: 'numeric',
            precision: 15,
            scale: 4,
            isNullable: true,
            comment:
              'Umbral genérico (cantidad o porcentaje). Forma del config interpreta el sentido.',
          },
          {
            name: 'config',
            type: 'jsonb',
            isNullable: false,
            default: `'{}'::jsonb`,
            comment: 'Parámetros específicos del evaluator. Forma libre (consumida en Fase 11).',
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
            name: 'chk_alert_configs_type_not_empty',
            expression: 'length(btrim(type)) > 0',
          },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'alert_configs',
      new TableForeignKey({
        name: 'fk_alert_configs_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'alert_configs',
      new TableIndex({
        name: 'idx_alert_configs_company_id',
        columnNames: ['company_id'],
      }),
    );

    // UNIQUE compuesto (company_id, type) — una config por (tenant, tipo).
    await queryRunner.createIndex(
      'alert_configs',
      new TableIndex({
        name: 'idx_alert_configs_company_type_unique',
        columnNames: ['company_id', 'type'],
        isUnique: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('alert_configs', 'idx_alert_configs_company_type_unique');
    await queryRunner.dropIndex('alert_configs', 'idx_alert_configs_company_id');
    await queryRunner.dropForeignKey('alert_configs', 'fk_alert_configs_company_id');
    await queryRunner.dropTable('alert_configs');
  }
}
