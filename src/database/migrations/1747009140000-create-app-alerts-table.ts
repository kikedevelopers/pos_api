import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 10 — Crea el tipo enum `alert_severity` y la tabla `app_alerts`.
 *
 * Espejo de la entidad `AppAlert.ts` de PlacePos con dos cambios:
 *
 *   - `company_id` NOT NULL con FK a `companies`.
 *   - `severity` enum nativo (INFO/WARNING/CRITICAL) — PlacePos no lo expone
 *     pero la fase lo pide explícitamente para que el frontend pueda
 *     renderizar badges. Si el cliente local no lo envía (no aplica:
 *     PlacePos no crea alertas, solo las consume), aceptamos `INFO` como
 *     default neutro.
 *
 *   - `metadata` jsonb nullable — espejo del `payload` jsonb de PlacePos
 *     (`AppAlert.payload`). Renombrado a `metadata` para coincidir con el
 *     spec de la Fase 10 (`metadata jsonb nullable`).
 *
 *   - `is_read` bool default false (idéntico a PlacePos).
 *
 *   - `title` y `message` text NOT NULL — añadidos sobre PlacePos para que
 *     la UI renderice texto sin tener que mapear desde `payload` por tipo.
 *     El cliente local crea las alertas con esos campos pre-renderizados.
 *
 * No incluimos los campos `read_at`/`read_by_id`/`entity_signature` ni
 * scheduler-related (`triggered_at`/`last_run_at`) por ahora — la fase
 * explícitamente NO implementa evaluators ni dedup. Si se necesitan
 * después, migración additive nueva.
 *
 * Índices: (company_id, is_read, created_at DESC) para el patrón típico
 * "alertas no leídas más recientes de mi company".
 */
export class CreateAppAlertsTable1747009140000 implements MigrationInterface {
  name = 'CreateAppAlertsTable1747009140000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Enum severity.
    await queryRunner.query(`
      CREATE TYPE alert_severity AS ENUM ('INFO', 'WARNING', 'CRITICAL')
    `);

    // 2. Tabla.
    await queryRunner.createTable(
      new Table({
        name: 'app_alerts',
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
            comment: 'Tenant al que pertenece la alerta. Asignado por el service desde JWT.',
          },
          {
            name: 'type',
            type: 'varchar',
            length: '50',
            isNullable: false,
            comment:
              'Identificador del tipo de alerta (string-enum). Crece sin migrar enums Postgres.',
          },
          {
            name: 'severity',
            type: 'alert_severity',
            isNullable: false,
            enumName: 'alert_severity',
            default: `'INFO'`,
          },
          {
            name: 'title',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'message',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'is_read',
            type: 'boolean',
            isNullable: false,
            default: false,
          },
          {
            name: 'metadata',
            type: 'jsonb',
            isNullable: true,
            comment: 'Payload tipado por tipo de alerta. Espejo de AppAlert.payload de PlacePos.',
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
            name: 'chk_app_alerts_title_not_empty',
            expression: 'length(btrim(title)) > 0',
          },
          {
            name: 'chk_app_alerts_message_not_empty',
            expression: 'length(btrim(message)) > 0',
          },
        ],
      }),
      true,
    );

    // 3. FK.
    await queryRunner.createForeignKey(
      'app_alerts',
      new TableForeignKey({
        name: 'fk_app_alerts_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 4. Índice por company_id (FK + filtro caliente).
    await queryRunner.createIndex(
      'app_alerts',
      new TableIndex({
        name: 'idx_app_alerts_company_id',
        columnNames: ['company_id'],
      }),
    );

    // 5. Índice compuesto para listado por fecha:
    //    SELECT ... WHERE company_id = $ ORDER BY created_at DESC LIMIT $.
    await queryRunner.createIndex(
      'app_alerts',
      new TableIndex({
        name: 'idx_app_alerts_company_created',
        columnNames: ['company_id', 'created_at'],
      }),
    );

    // 6. Índice parcial para `?unread_only=true` y el unread_count badge:
    //    WHERE company_id = $ AND is_read = false ORDER BY created_at DESC.
    await queryRunner.query(`
      CREATE INDEX idx_app_alerts_company_unread
      ON app_alerts (company_id, created_at DESC)
      WHERE is_read = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_app_alerts_company_unread');
    await queryRunner.dropIndex('app_alerts', 'idx_app_alerts_company_created');
    await queryRunner.dropIndex('app_alerts', 'idx_app_alerts_company_id');
    await queryRunner.dropForeignKey('app_alerts', 'fk_app_alerts_company_id');
    await queryRunner.dropTable('app_alerts');
    await queryRunner.query('DROP TYPE IF EXISTS alert_severity');
  }
}
