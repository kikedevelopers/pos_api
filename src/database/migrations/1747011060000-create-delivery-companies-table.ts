import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Módulo Domiciliarios — Crea la tabla `delivery_companies` (catálogo de
 * domiciliarios / transportadoras de domicilios).
 *
 * Espejo del feature "Domiciliarios" de PlacePos con extensión multi-tenant
 * (`company_id` denormalizado, FK e índice).
 *
 * --------------------------------------------------------------------------
 * Decisiones de modelado
 * --------------------------------------------------------------------------
 *
 *   - `phones jsonb NOT NULL DEFAULT '[]'` — lista de teléfonos como array de
 *     strings. Se valida máx 4 en el DTO. jsonb permite que el frontend
 *     reciba/envíe siempre un `string[]` sin tablas auxiliares.
 *
 *   - `is_archived boolean` — soft-delete convención PlacePos. A diferencia de
 *     `suppliers` (solo archive), aquí el contrato expone archive + unarchive.
 *
 *   - `name` NOT NULL no-blank (CHECK).
 *
 * --------------------------------------------------------------------------
 * Índices
 * --------------------------------------------------------------------------
 *
 *   a) `(company_id)` — lookups por tenant.
 *   b) `(company_id, name)` — orden/búsqueda por nombre dentro del tenant.
 */
export class CreateDeliveryCompaniesTable1747011060000 implements MigrationInterface {
  name = 'CreateDeliveryCompaniesTable1747011060000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'delivery_companies',
        columns: [
          { name: 'id', type: 'bigserial', isPrimary: true },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: false,
            comment:
              'Tenant al que pertenece el domiciliario. Asignado por el service desde req.user.company_id.',
          },
          { name: 'name', type: 'text', isNullable: false },
          { name: 'address', type: 'text', isNullable: true },
          {
            name: 'phones',
            type: 'jsonb',
            isNullable: false,
            default: `'[]'::jsonb`,
            comment: 'Array de teléfonos (string[]). Máx 4 (validado en el DTO).',
          },
          {
            name: 'is_archived',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment: 'Soft-delete convención PlacePos. Reversible vía /unarchive.',
          },
          { name: 'created_by', type: 'text', isNullable: true },
          { name: 'created_by_id', type: 'bigint', isNullable: true },
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
            name: 'chk_delivery_companies_name_not_empty',
            expression: 'length(btrim(name)) > 0',
          },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'delivery_companies',
      new TableForeignKey({
        name: 'fk_delivery_companies_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'delivery_companies',
      new TableIndex({
        name: 'idx_delivery_companies_company_id',
        columnNames: ['company_id'],
      }),
    );

    await queryRunner.createIndex(
      'delivery_companies',
      new TableIndex({
        name: 'idx_delivery_companies_company_name',
        columnNames: ['company_id', 'name'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('delivery_companies', 'idx_delivery_companies_company_name');
    await queryRunner.dropIndex('delivery_companies', 'idx_delivery_companies_company_id');
    await queryRunner.dropForeignKey('delivery_companies', 'fk_delivery_companies_company_id');
    await queryRunner.dropTable('delivery_companies');
  }
}
