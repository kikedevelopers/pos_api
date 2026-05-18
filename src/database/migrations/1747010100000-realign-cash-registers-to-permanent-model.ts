import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 3.5 — Realinear `cash_registers` al modelo PERMANENTE de PlacePos.
 *
 * --------------------------------------------------------------------------
 * Motivación
 * --------------------------------------------------------------------------
 *
 * PlacePos modela `cash_register` como UN row persistente por usuario con
 * columna `balance` mutable (sin concepto de turno: apertura/cierre). El
 * modelo de TURNOS introducido en la migración `1747008600000` divergía del
 * contrato y bloqueaba la Fase 4 (sales / payments). Esta migración descarta
 * el modelo viejo y recrea la tabla con el shape de PlacePos.
 *
 * pos_api NO está en producción → DROP destructivos son OK.
 *
 * --------------------------------------------------------------------------
 * Cambios
 * --------------------------------------------------------------------------
 *
 *   1. DROP CHECKs del modelo de turnos: `chk_cash_registers_opener_xor`,
 *      `chk_cash_registers_closed_complete`,
 *      `chk_cash_registers_opening_balance_non_negative`.
 *
 *   2. DROP índices `idx_cash_registers_one_open_per_company` (UNIQUE parcial
 *      `WHERE status='open'`) y `idx_cash_registers_company_opened_at`.
 *
 *   3. DROP columnas del modelo de turnos: `opening_balance`, `closing_balance`,
 *      `expected_balance`, `difference`, `status`, `opened_at`, `closed_at`,
 *      `opened_by_user_id`, `opened_by_employee_id`, `opened_by_name`.
 *
 *   4. DROP tipo `cash_register_status` (ya no se usa).
 *
 *   5. ADD `user_id bigint NULL` con FK a `users(id) ON DELETE SET NULL`.
 *      Identifica el "dueño" de la caja (un User-owner o un User-manager).
 *      NULL admitido para cajas históricas o de empleados sin fila en
 *      `users` (escenario explícito).
 *
 *   6. ADD `balance numeric(15,2) NOT NULL DEFAULT 0` con CHECK >= 0.
 *      Balance corriente mutable (no derivado de logs en este modelo).
 *
 *   7. ADD `base_amount numeric(15,2) NOT NULL DEFAULT 0` con CHECK >= 0.
 *      Fondo fijo (espejo PlacePos).
 *
 *   8. ADD UNIQUE parcial `(company_id, user_id) WHERE user_id IS NOT NULL`:
 *      una caja por usuario por company.
 *
 *   9. ADD index `(company_id, user_id)` para lookups frecuentes.
 *
 * --------------------------------------------------------------------------
 * Down
 * --------------------------------------------------------------------------
 *
 * Restaura el modelo de turnos. NO repobla datos — eso es responsabilidad
 * del operador si lo necesita.
 */
export class RealignCashRegistersToPermanentModel1747010100000 implements MigrationInterface {
  name = 'RealignCashRegistersToPermanentModel1747010100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. DROP CHECKs del modelo de turnos.
    await queryRunner.query(
      `ALTER TABLE "cash_registers" DROP CONSTRAINT IF EXISTS "chk_cash_registers_opener_xor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_registers" DROP CONSTRAINT IF EXISTS "chk_cash_registers_closed_complete"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_registers" DROP CONSTRAINT IF EXISTS "chk_cash_registers_opening_balance_non_negative"`,
    );

    // 2. DROP índices del modelo de turnos.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cash_registers_one_open_per_company"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cash_registers_company_opened_at"`);

    // 3. DROP columnas del modelo de turnos.
    await queryRunner.query(
      `ALTER TABLE "cash_registers"
       DROP COLUMN IF EXISTS "opening_balance",
       DROP COLUMN IF EXISTS "closing_balance",
       DROP COLUMN IF EXISTS "expected_balance",
       DROP COLUMN IF EXISTS "difference",
       DROP COLUMN IF EXISTS "status",
       DROP COLUMN IF EXISTS "opened_at",
       DROP COLUMN IF EXISTS "closed_at",
       DROP COLUMN IF EXISTS "opened_by_user_id",
       DROP COLUMN IF EXISTS "opened_by_employee_id",
       DROP COLUMN IF EXISTS "opened_by_name"`,
    );

    // 4. DROP enum cash_register_status (sin referencias tras paso 3).
    await queryRunner.query(`DROP TYPE IF EXISTS "cash_register_status"`);

    // 5. ADD user_id bigint NULL con FK a users.
    await queryRunner.query(`ALTER TABLE "cash_registers" ADD COLUMN "user_id" bigint NULL`);
    await queryRunner.query(
      `ALTER TABLE "cash_registers"
       ADD CONSTRAINT "fk_cash_registers_user_id"
       FOREIGN KEY ("user_id") REFERENCES "users" ("id")
       ON DELETE SET NULL ON UPDATE CASCADE`,
    );

    // 6. ADD balance numeric(15,2) NOT NULL DEFAULT 0 CHECK >= 0.
    await queryRunner.query(
      `ALTER TABLE "cash_registers"
       ADD COLUMN "balance" numeric(15, 2) NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_registers"
       ADD CONSTRAINT "chk_cash_registers_balance_non_negative" CHECK ("balance" >= 0)`,
    );

    // 7. ADD base_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK >= 0.
    await queryRunner.query(
      `ALTER TABLE "cash_registers"
       ADD COLUMN "base_amount" numeric(15, 2) NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_registers"
       ADD CONSTRAINT "chk_cash_registers_base_amount_non_negative" CHECK ("base_amount" >= 0)`,
    );

    // 8. UNIQUE parcial (company_id, user_id) WHERE user_id IS NOT NULL.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_cash_registers_company_user_unique"
       ON "cash_registers" ("company_id", "user_id")
       WHERE "user_id" IS NOT NULL`,
    );

    // 9. Index (company_id, user_id) para lookups frecuentes.
    await queryRunner.query(
      `CREATE INDEX "idx_cash_registers_company_user"
       ON "cash_registers" ("company_id", "user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 9. DROP indices nuevos.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cash_registers_company_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cash_registers_company_user_unique"`);

    // 7/6. DROP CHECKs nuevos.
    await queryRunner.query(
      `ALTER TABLE "cash_registers" DROP CONSTRAINT IF EXISTS "chk_cash_registers_base_amount_non_negative"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_registers" DROP CONSTRAINT IF EXISTS "chk_cash_registers_balance_non_negative"`,
    );

    // 5. DROP FK + columnas nuevas.
    await queryRunner.query(
      `ALTER TABLE "cash_registers" DROP CONSTRAINT IF EXISTS "fk_cash_registers_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_registers"
       DROP COLUMN IF EXISTS "user_id",
       DROP COLUMN IF EXISTS "balance",
       DROP COLUMN IF EXISTS "base_amount"`,
    );

    // 4. Recrear enum cash_register_status.
    await queryRunner.query(`CREATE TYPE "cash_register_status" AS ENUM ('open', 'closed')`);

    // 3. Recrear columnas del modelo de turnos.
    await queryRunner.query(
      `ALTER TABLE "cash_registers"
       ADD COLUMN "opened_by_user_id" bigint NULL,
       ADD COLUMN "opened_by_employee_id" bigint NULL,
       ADD COLUMN "opened_by_name" text NULL,
       ADD COLUMN "opening_balance" numeric(15, 2) NOT NULL DEFAULT 0,
       ADD COLUMN "closing_balance" numeric(15, 2) NULL,
       ADD COLUMN "expected_balance" numeric(15, 2) NULL,
       ADD COLUMN "difference" numeric(15, 2) NULL,
       ADD COLUMN "status" "cash_register_status" NOT NULL DEFAULT 'open',
       ADD COLUMN "opened_at" timestamptz NOT NULL DEFAULT now(),
       ADD COLUMN "closed_at" timestamptz NULL`,
    );

    // 1. Recrear CHECKs del modelo de turnos.
    await queryRunner.query(
      `ALTER TABLE "cash_registers"
       ADD CONSTRAINT "chk_cash_registers_opener_xor" CHECK (
         (opened_by_user_id IS NOT NULL AND opened_by_employee_id IS NULL)
         OR (opened_by_user_id IS NULL AND opened_by_employee_id IS NOT NULL)
       )`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_registers"
       ADD CONSTRAINT "chk_cash_registers_closed_complete" CHECK (
         status = 'open'
         OR (
           closing_balance IS NOT NULL
           AND expected_balance IS NOT NULL
           AND difference IS NOT NULL
           AND closed_at IS NOT NULL
         )
       )`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_registers"
       ADD CONSTRAINT "chk_cash_registers_opening_balance_non_negative"
       CHECK (opening_balance >= 0)`,
    );

    // 2. Recrear índices del modelo de turnos.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_cash_registers_one_open_per_company"
       ON "cash_registers" ("company_id")
       WHERE status = 'open'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_cash_registers_company_opened_at"
       ON "cash_registers" ("company_id", "opened_at" DESC)`,
    );
  }
}
