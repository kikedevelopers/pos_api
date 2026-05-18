import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 4A — Añade `employees.user_id` (FK a `users.id`) para soportar el
 * patrón **User-espejo de Employee**.
 *
 * --------------------------------------------------------------------------
 * Motivación
 * --------------------------------------------------------------------------
 *
 * El modelo PERMANENTE de PlacePos ata la caja registradora, los
 * `cash_register_log` y `financial_movements.created_by_id` a `users.id`
 * (no a `employees.id`). Para que un Employee pueda operar caja, necesita
 * tener una fila ESPEJO en `users` con `type='employee'`. La columna
 * `employees.user_id` enlaza el employee con su user espejo y blinda la
 * unicidad (un User no puede ser espejo de más de un Employee).
 *
 * El user espejo se crea on-demand en:
 *   - `LoginAction` cuando un Employee con `login_enabled=true` autentica
 *     por primera vez después de habilitar el login.
 *   - `CreateEmployeeAction` cuando se crea un Employee con `login_enabled
 *     =true` (creación inmediata para que el employee pueda operar caja
 *     sin esperar al primer login).
 *   - `ToggleEmployeeLoginAction` cuando se pasa `login_enabled=false→true`.
 *
 * Para la lógica detallada ver `ensureMirrorUserForEmployee`.
 *
 * --------------------------------------------------------------------------
 * Cambios
 * --------------------------------------------------------------------------
 *
 *   1. ADD `user_id bigint NULL` en `employees`.
 *   2. ADD FK `fk_employees_user_id` (employees.user_id → users.id)
 *      ON DELETE SET NULL ON UPDATE CASCADE. El SET NULL preserva la fila
 *      del employee si por algún drift el user espejo se borrara.
 *   3. ADD UNIQUE parcial `(user_id) WHERE user_id IS NOT NULL`. Garantiza
 *      que un User espejo no se asocie a múltiples Employees. NULL múltiples
 *      permitidos (employee sin login todavía).
 *   4. ADD index `(company_id, user_id)` — patrón espejo del index de
 *      `cash_registers`. Acelera el join Employee↔CashRegister vía user_id
 *      cuando se listan empleados con su caja.
 */
export class AddUserIdToEmployees1747010340000 implements MigrationInterface {
  name = 'AddUserIdToEmployees1747010340000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. ADD columna user_id.
    await queryRunner.query(`ALTER TABLE "employees" ADD COLUMN "user_id" bigint NULL`);

    // 2. FK a users.id. ON DELETE SET NULL: si el user espejo desaparece por
    //    drift, el employee queda con user_id NULL pero no se borra.
    await queryRunner.query(
      `ALTER TABLE "employees"
       ADD CONSTRAINT "fk_employees_user_id"
       FOREIGN KEY ("user_id") REFERENCES "users" ("id")
       ON DELETE SET NULL ON UPDATE CASCADE`,
    );

    // 3. UNIQUE parcial: un User es espejo de a lo más un Employee.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_employees_user_id_unique"
       ON "employees" ("user_id")
       WHERE "user_id" IS NOT NULL`,
    );

    // 4. Index compuesto (company_id, user_id). Lookups frecuentes:
    //    listar employees por company y resolver su caja por user_id.
    await queryRunner.query(
      `CREATE INDEX "idx_employees_company_user"
       ON "employees" ("company_id", "user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_employees_company_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_employees_user_id_unique"`);
    await queryRunner.query(
      `ALTER TABLE "employees" DROP CONSTRAINT IF EXISTS "fk_employees_user_id"`,
    );
    await queryRunner.query(`ALTER TABLE "employees" DROP COLUMN IF EXISTS "user_id"`);
  }
}
