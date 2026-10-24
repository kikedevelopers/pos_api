import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Planes de préstamo (modo prestamista, cloud-only).
 *
 * Un plan es la plantilla que el prestamista guarda para prestar rápido:
 *
 *   - `plan_type`: interest_only (interés sobre el saldo + abono libre a
 *     capital) | fixed_installment (cuota fija que salda en N periodos) |
 *     daily_installment (esa cuota fija cobrada en pagos diarios).
 *   - `interest_rate` (%) por `rate_period` (monthly | biweekly | weekly).
 *   - `installments_count`: número de cuotas (solo cuota fija/diaria).
 *   - `collection_days`: días de cobro por periodo (solo cuota diaria).
 *
 * Los CHECK replican en la base las reglas de `loan-plan-rules.ts`, para que
 * ningún camino deje un plan incoherente (p. ej. cuota diaria sin días). Los
 * `IS NOT NULL` son obligatorios: `NULL BETWEEN 1 AND 31` da NULL, y un CHECK
 * que da NULL se ACEPTA en Postgres.
 *
 * Multi-tenancy: `company_id` NOT NULL + FK ON DELETE CASCADE + índice; UNIQUE
 * per-company parcial sobre `lower(btrim(name))` entre los no archivados.
 */
export class CreateLoanPlans1747012960000 implements MigrationInterface {
  name = 'CreateLoanPlans1747012960000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loan_plans_plan_type_enum') THEN
          CREATE TYPE "loan_plans_plan_type_enum" AS ENUM ('interest_only', 'fixed_installment', 'daily_installment');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loan_plans_rate_period_enum') THEN
          CREATE TYPE "loan_plans_rate_period_enum" AS ENUM ('monthly', 'biweekly', 'weekly');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "loan_plans" (
        "id" bigserial PRIMARY KEY,
        "company_id" bigint NOT NULL,
        "name" text NOT NULL,
        "description" text NULL,
        "plan_type" "loan_plans_plan_type_enum" NOT NULL,
        "interest_rate" numeric(7,4) NOT NULL,
        "rate_period" "loan_plans_rate_period_enum" NOT NULL,
        "installments_count" integer NULL,
        "collection_days" integer NULL,
        "is_archived" boolean NOT NULL DEFAULT false,
        "created_by" text NULL,
        "created_by_id" bigint NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_loan_plans_name_not_empty" CHECK (length(btrim(name)) > 0),
        CONSTRAINT "chk_loan_plans_rate_range" CHECK (interest_rate >= 0 AND interest_rate <= 100),
        CONSTRAINT "chk_loan_plans_installments" CHECK (
          (plan_type = 'interest_only' AND installments_count IS NULL)
          OR (plan_type <> 'interest_only' AND installments_count IS NOT NULL
              AND installments_count BETWEEN 1 AND 360)
        ),
        CONSTRAINT "chk_loan_plans_collection_days" CHECK (
          (plan_type = 'daily_installment' AND collection_days IS NOT NULL
              AND collection_days BETWEEN 1 AND 31)
          OR (plan_type <> 'daily_installment' AND collection_days IS NULL)
        ),
        CONSTRAINT "fk_loan_plans_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_loan_plans_company_id" ON "loan_plans" ("company_id")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_loan_plans_company_name_unique"
      ON "loan_plans" ("company_id", lower(btrim(name)))
      WHERE is_archived = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "loan_plans"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "loan_plans_rate_period_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "loan_plans_plan_type_enum"`);
  }
}
