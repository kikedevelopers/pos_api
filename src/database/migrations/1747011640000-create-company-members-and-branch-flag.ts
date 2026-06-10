import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Multi-sucursal (cloud) — Crea `company_members` y añade `companies.is_branch`.
 *
 * --------------------------------------------------------------------------
 * `company_members`
 * --------------------------------------------------------------------------
 *   Pertenencia owner→companies. Un owner puede ser miembro de varias companies
 *   (sucursales). Fuente de verdad para autorizar el switch de sucursal
 *   (anti-IDOR) y listar las sucursales del owner. NO reemplaza
 *   `users.company_id` (que sigue siendo la company primaria/por defecto).
 *
 *     - `user_id`  FK users    ON DELETE CASCADE
 *     - `company_id` FK companies ON DELETE CASCADE
 *     - UNIQUE(user_id, company_id) — una fila por par; sirve de lookup.
 *     - index(user_id) — listado de sucursales del owner.
 *
 * --------------------------------------------------------------------------
 * `companies.is_branch`
 * --------------------------------------------------------------------------
 *   `false` (DEFAULT) para el primer negocio; `true` para sucursales creadas
 *   vía `POST /branches`. Aditivo: las companies existentes quedan `false` sin
 *   backfill explícito.
 *
 * --------------------------------------------------------------------------
 * BACKFILL (idempotente)
 * --------------------------------------------------------------------------
 *   Una fila en company_members por cada owner existente con su company actual.
 *   `ON CONFLICT DO NOTHING` por el UNIQUE (defensa ante doble ejecución).
 */
export class CreateCompanyMembersAndBranchFlag1747011640000 implements MigrationInterface {
  name = 'CreateCompanyMembersAndBranchFlag1747011640000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'companies',
      new TableColumn({
        name: 'is_branch',
        type: 'boolean',
        isNullable: false,
        default: false,
        comment: 'true para sucursales creadas tras el primer negocio del owner.',
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'company_members',
        columns: [
          { name: 'id', type: 'bigserial', isPrimary: true },
          {
            name: 'user_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Usuario (owner) miembro de la company.',
          },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Company (sucursal) a la que pertenece el usuario.',
          },
          {
            name: 'role',
            type: 'text',
            isNullable: false,
            default: `'owner'`,
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            isNullable: false,
            default: 'now()',
          },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'company_members',
      new TableForeignKey({
        name: 'fk_company_members_user_id',
        columnNames: ['user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'company_members',
      new TableForeignKey({
        name: 'fk_company_members_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'company_members',
      new TableIndex({
        name: 'idx_company_members_user_company_unique',
        columnNames: ['user_id', 'company_id'],
        isUnique: true,
      }),
    );

    await queryRunner.createIndex(
      'company_members',
      new TableIndex({
        name: 'idx_company_members_user_id',
        columnNames: ['user_id'],
      }),
    );

    // Lookup del guard de suscripción: resuelve el owner de una company
    // (principal o sucursal) filtrando por company_id.
    await queryRunner.createIndex(
      'company_members',
      new TableIndex({
        name: 'idx_company_members_company_id',
        columnNames: ['company_id'],
      }),
    );

    // BACKFILL idempotente: cada owner existente → su company actual.
    await queryRunner.query(`
      INSERT INTO company_members (user_id, company_id, role)
      SELECT u.id, u.company_id, 'owner'
      FROM users u
      WHERE u.type = 'owner' AND u.company_id IS NOT NULL
      ON CONFLICT (user_id, company_id) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('company_members');
    await queryRunner.dropColumn('companies', 'is_branch');
  }
}
