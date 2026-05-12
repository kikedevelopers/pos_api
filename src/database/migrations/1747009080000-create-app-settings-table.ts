import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 10 — Crea la tabla `app_settings`.
 *
 * Espejo de la entidad `AppSetting.ts` de PlacePos adaptada a multi-tenancy:
 *
 *   - PlacePos local: `UNIQUE(key)` GLOBAL.
 *   - Aquí: `UNIQUE(company_id, key)` — dos companies pueden tener cada una
 *     un `app_color_mode = 'dark'` independiente.
 *
 * Estructura clave-valor:
 *
 *   - `key text NOT NULL` — identificador del setting (ej. `app_color_mode`,
 *     `pos_margins_enabled`, `pos_margins`).
 *   - `value text NOT NULL` — valor serializado. Para arrays/objetos PlacePos
 *     usa `JSON.stringify` (ver `app-settings.routes.ts` línea 120). Aquí lo
 *     mantenemos byte-a-byte: el cliente sigue serializando del mismo modo.
 *
 * Seed: las dos claves por defecto (`app_color_mode='white'`,
 * `pos_margins_enabled='false'`) las inserta `CreateDefaultAppSettingsAction`
 * desde `RegisterAction` dentro de la transacción del registro.
 */
export class CreateAppSettingsTable1747009080000 implements MigrationInterface {
  name = 'CreateAppSettingsTable1747009080000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'app_settings',
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
            comment:
              'Tenant al que pertenece el setting. Asignado por el service desde req.user.company_id.',
          },
          {
            name: 'key',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'value',
            type: 'text',
            isNullable: false,
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
            name: 'chk_app_settings_key_not_empty',
            expression: 'length(btrim(key)) > 0',
          },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'app_settings',
      new TableForeignKey({
        name: 'fk_app_settings_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'app_settings',
      new TableIndex({
        name: 'idx_app_settings_company_id',
        columnNames: ['company_id'],
      }),
    );

    // UNIQUE (company_id, key). Sirve también como índice de lookup para
    // GET /app-settings/:key y la upsert en PUT.
    await queryRunner.createIndex(
      'app_settings',
      new TableIndex({
        name: 'idx_app_settings_company_key_unique',
        columnNames: ['company_id', 'key'],
        isUnique: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('app_settings', 'idx_app_settings_company_key_unique');
    await queryRunner.dropIndex('app_settings', 'idx_app_settings_company_id');
    await queryRunner.dropForeignKey('app_settings', 'fk_app_settings_company_id');
    await queryRunner.dropTable('app_settings');
  }
}
