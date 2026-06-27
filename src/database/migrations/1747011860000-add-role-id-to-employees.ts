import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FASE 1 (ROLES Y PERMISOS) — añade `employees.role_id`.
 *
 * Vincula un empleado a un rol PERSONALIZADO (`roles.id`). NULL = sin rol
 * asignado todavía (cae al control por rol fijo legacy hasta Fase 2).
 *
 *   - FK role_id → roles ON DELETE SET NULL (borrar un rol desasigna a sus
 *     empleados, no los borra), ON UPDATE CASCADE.
 *   - Índice `idx_employees_role_id` para el lookup inverso ("¿qué empleados
 *     usan este rol?") y para el JOIN al resolver permisos efectivos en Fase 2.
 *
 * Aditiva e idempotente: `ADD COLUMN IF NOT EXISTS`, FK e índice sólo si no
 * existen.
 */
export class AddRoleIdToEmployees1747011860000 implements MigrationInterface {
  name = 'AddRoleIdToEmployees1747011860000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "employees"
      ADD COLUMN IF NOT EXISTS "role_id" bigint NULL
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_employees_role_id'
        ) THEN
          ALTER TABLE "employees"
          ADD CONSTRAINT "fk_employees_role_id"
            FOREIGN KEY ("role_id") REFERENCES "roles" ("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_employees_role_id ON employees (role_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_employees_role_id`);
    await queryRunner.query(
      `ALTER TABLE "employees" DROP CONSTRAINT IF EXISTS "fk_employees_role_id"`,
    );
    await queryRunner.query(`ALTER TABLE "employees" DROP COLUMN IF EXISTS "role_id"`);
  }
}
