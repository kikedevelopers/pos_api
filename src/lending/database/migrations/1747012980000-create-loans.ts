import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Préstamos (modo prestamista, cloud-only).
 *
 * Un préstamo = cliente + plan + capital prestado, desembolsado desde una caja,
 * banco o billetera. Guarda una COPIA de las condiciones del plan (tipo, tasa,
 * periodo, cuotas, días de cobro): editar o archivar el plan después no cambia
 * lo que se pactó con el cliente.
 *
 *   - `principal`: capital prestado.
 *   - `outstanding_principal`: capital que falta por pagar (arranca igual al
 *     principal; lo bajan los abonos a capital).
 *   - `installment_amount` / `daily_amount`: cuota por periodo y pago diario
 *     calculados al prestar (null en interés fijo / donde no aplica).
 *   - `start_date`: desde cuándo corre el préstamo (hoy por defecto, editable
 *     para registrar préstamos anteriores).
 *   - `source_*`: de dónde salió el dinero (snapshot del nombre incluido).
 *
 * Multi-tenancy: `company_id` NOT NULL + FK CASCADE + índices por company.
 * `customer_id` RESTRICT (un cliente con préstamos no se borra físicamente;
 * se archiva). `loan_plan_id` SET NULL (el préstamo conserva su copia).
 */
export class CreateLoans1747012980000 implements MigrationInterface {
  name = 'CreateLoans1747012980000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loans_status_enum') THEN
          CREATE TYPE "loans_status_enum" AS ENUM ('active', 'paid', 'cancelled');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "loans" (
        "id" bigserial PRIMARY KEY,
        "company_id" bigint NOT NULL,
        "customer_id" bigint NOT NULL,
        "loan_plan_id" bigint NULL,
        "plan_name" text NOT NULL,
        "plan_type" "loan_plans_plan_type_enum" NOT NULL,
        "interest_rate" numeric(7,4) NOT NULL,
        "rate_period" "loan_plans_rate_period_enum" NOT NULL,
        "installments_count" integer NULL,
        "collection_days" integer NULL,
        "principal" numeric(14,2) NOT NULL,
        "outstanding_principal" numeric(14,2) NOT NULL,
        "installment_amount" numeric(14,2) NULL,
        "daily_amount" numeric(14,2) NULL,
        "start_date" date NOT NULL,
        "status" "loans_status_enum" NOT NULL DEFAULT 'active',
        "source_type" text NOT NULL,
        "source_id" bigint NOT NULL,
        "source_name" text NOT NULL,
        "reference_code" text NOT NULL,
        "notes" text NULL,
        "created_by" text NULL,
        "created_by_id" bigint NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_loans_principal_positive" CHECK (principal > 0),
        CONSTRAINT "chk_loans_outstanding_range" CHECK (
          outstanding_principal >= 0 AND outstanding_principal <= principal
        ),
        CONSTRAINT "chk_loans_rate_range" CHECK (interest_rate >= 0 AND interest_rate <= 100),
        CONSTRAINT "chk_loans_source_type" CHECK (source_type IN ('cash_register', 'bank', 'wallet')),
        CONSTRAINT "fk_loans_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "fk_loans_customer_id" FOREIGN KEY ("customer_id")
          REFERENCES "customers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT "fk_loans_loan_plan_id" FOREIGN KEY ("loan_plan_id")
          REFERENCES "loan_plans" ("id") ON DELETE SET NULL ON UPDATE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_loans_company_status" ON "loans" ("company_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_loans_company_customer" ON "loans" ("company_id", "customer_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_loans_reference_code" ON "loans" ("reference_code")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "loans"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "loans_status_enum"`);
  }
}
