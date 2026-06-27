import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * FASE 1 (ROLES Y PERMISOS) — Crea `roles`.
 *
 * Rol PERSONALIZADO de acceso a módulos por company (multi-tenant). Un
 * `Employee` apuntará a `role_id` (ver migración siguiente). El array
 * `permissions` (jsonb) guarda keys del catálogo canónico de permisos
 * (idéntico a placepos). owner/superadmin no dependen de esta tabla: siempre
 * tienen acceso total.
 *
 * --------------------------------------------------------------------------
 * Unicidad por company (índice funcional)
 * --------------------------------------------------------------------------
 *
 *   `idx_roles_company_name_unique` UNIQUE(company_id, lower(btrim(name))).
 *   Índice de EXPRESIÓN: TypeORM no lo expresa con `TableIndex` de forma
 *   portable → SQL crudo. Impide nombres duplicados (case/trim-insensitive)
 *   dentro de una company.
 *
 * --------------------------------------------------------------------------
 * FK
 * --------------------------------------------------------------------------
 *
 *   - company_id → companies ON DELETE RESTRICT (no borrar company con roles),
 *     ON UPDATE CASCADE.
 *
 * Aditiva e idempotente (`createTable(..., true)` usa IF NOT EXISTS; CHECK e
 * índice funcional se crean sólo si no existen).
 */
export class CreateRolesTable1747011840000 implements MigrationInterface {
  name = 'CreateRolesTable1747011840000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'roles',
        columns: [
          { name: 'id', type: 'bigserial', isPrimary: true },
          {
            name: 'company_id',
            type: 'bigint',
            isNullable: false,
            comment: 'Tenant dueño del rol.',
          },
          { name: 'name', type: 'text', isNullable: false },
          {
            name: 'color',
            type: 'text',
            isNullable: true,
            comment: 'Color hex de presentación (ej. #6366f1).',
          },
          {
            name: 'icon',
            type: 'text',
            isNullable: true,
            comment: 'Nombre de ícono lucide (ej. UserCog).',
          },
          {
            name: 'permissions',
            type: 'jsonb',
            isNullable: false,
            default: "'[]'",
            comment: 'Array de keys de permiso del catálogo canónico.',
          },
          {
            name: 'is_system',
            type: 'boolean',
            isNullable: false,
            default: false,
            comment: 'Rol de fábrica no borrable.',
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
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'roles',
      new TableForeignKey({
        name: 'fk_roles_company_id',
        columnNames: ['company_id'],
        referencedTableName: 'companies',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }),
    );

    // Índice por company — todo listado/lookup filtra por tenant.
    await queryRunner.createIndex(
      'roles',
      new TableIndex({
        name: 'idx_roles_company_id',
        columnNames: ['company_id'],
      }),
    );

    // CHECK: nombre no vacío (idempotente).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_roles_name_not_empty'
        ) THEN
          ALTER TABLE "roles"
          ADD CONSTRAINT "chk_roles_name_not_empty" CHECK (length(btrim(name)) > 0);
        END IF;
      END $$;
    `);

    // Índice único funcional (case/trim-insensitive) por company.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_company_name_unique
      ON roles (company_id, lower(btrim(name)))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_roles_company_name_unique`);
    await queryRunner.query(
      `ALTER TABLE "roles" DROP CONSTRAINT IF EXISTS "chk_roles_name_not_empty"`,
    );
    await queryRunner.dropIndex('roles', 'idx_roles_company_id');
    await queryRunner.dropForeignKey('roles', 'fk_roles_company_id');
    await queryRunner.dropTable('roles');
  }
}
