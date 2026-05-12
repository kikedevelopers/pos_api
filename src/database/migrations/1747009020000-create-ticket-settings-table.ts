import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fase 10 — Crea el tipo enum `ticket_setting_type` y la tabla `ticket_settings`.
 *
 * Espejo de la entidad `TicketSetting.ts` de PlacePos, adaptada a multi-tenancy:
 *
 *   - `company_id` NOT NULL con FK a `companies` (RESTRICT). Toda query lo filtra.
 *
 *   - `ticket_type` enum nativo Postgres con cinco valores:
 *       ORDER | SALE | CREDIT_NOTE | DEBIT_NOTE | PURCHASE.
 *     PlacePos local lo declara con valores idénticos (`enumName = ticket_setting_type`);
 *     conservamos el mismo enumName y miembros para que las migraciones queden
 *     en paridad léxica con el cliente de escritorio.
 *
 *   - `current_number integer NOT NULL DEFAULT 0` — pre-incremento. El servicio
 *     usa `UPDATE ... SET current_number = current_number + 1 RETURNING ...`
 *     para obtener atómicamente el próximo número y formatearlo con
 *     `{prefix}{padded}{suffix}`. Default 0 implica que el primer ticket
 *     formateado lleve el número 1 (`current_number` ya incrementado).
 *
 *   - `prefix` / `suffix` nullable. PlacePos local los maneja como string
 *     (con prefix UNIQUE GLOBAL). Aquí los hacemos opcionales per-company:
 *     dos tenants pueden tener cada uno prefix "F" sin colisionar.
 *
 *   - UNIQUE `(company_id, ticket_type)` — una sola fila de configuración por
 *     tipo de ticket por tenant. Sirve también como índice de lookup para
 *     `IncrementTicketNumberAction`.
 *
 * Seed: las cinco filas iniciales (una por enum value) las inserta
 * `CreateDefaultTicketSettingsAction` invocado desde `RegisterAction` dentro
 * de la transacción del registro. Si el seed falla → rollback total.
 */
export class CreateTicketSettingsTable1747009020000 implements MigrationInterface {
  name = 'CreateTicketSettingsTable1747009020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tipo enum nativo Postgres.
    await queryRunner.query(`
      CREATE TYPE ticket_setting_type AS ENUM (
        'ORDER',
        'SALE',
        'CREDIT_NOTE',
        'DEBIT_NOTE',
        'PURCHASE'
      )
    `);

    // 2. Tabla ticket_settings.
    await queryRunner.createTable(
      new Table({
        name: 'ticket_settings',
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
              'Tenant al que pertenece la configuración de folio. Asignado por el seed del RegisterAction.',
          },
          {
            name: 'ticket_type',
            type: 'ticket_setting_type',
            isNullable: false,
            enumName: 'ticket_setting_type',
          },
          {
            name: 'current_number',
            type: 'integer',
            isNullable: false,
            default: 0,
            comment:
              'Pre-incremento. UPDATE current_number = current_number + 1 RETURNING ... es atómico (lock implícito de la row).',
          },
          {
            name: 'prefix',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'suffix',
            type: 'text',
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
            name: 'chk_ticket_settings_current_number_non_negative',
            expression: 'current_number >= 0',
          },
        ],
      }),
      true,
    );

    // 3. FK a companies. RESTRICT — no se borra una company con folios activos.
    await queryRunner.createForeignKey(
      'ticket_settings',
      new TableForeignKey({
        name: 'fk_ticket_settings_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // 4. Índice por company_id (FK + filtro caliente).
    await queryRunner.createIndex(
      'ticket_settings',
      new TableIndex({
        name: 'idx_ticket_settings_company_id',
        columnNames: ['company_id'],
      }),
    );

    // 5. UNIQUE compuesto (company_id, ticket_type).
    //    Una sola fila de configuración por tipo de ticket por tenant.
    //    Esto sirve también como índice de lookup para el incremento atómico.
    await queryRunner.createIndex(
      'ticket_settings',
      new TableIndex({
        name: 'idx_ticket_settings_company_type_unique',
        columnNames: ['company_id', 'ticket_type'],
        isUnique: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('ticket_settings', 'idx_ticket_settings_company_type_unique');
    await queryRunner.dropIndex('ticket_settings', 'idx_ticket_settings_company_id');
    await queryRunner.dropForeignKey('ticket_settings', 'fk_ticket_settings_company_id');
    await queryRunner.dropTable('ticket_settings');
    await queryRunner.query('DROP TYPE IF EXISTS ticket_setting_type');
  }
}
