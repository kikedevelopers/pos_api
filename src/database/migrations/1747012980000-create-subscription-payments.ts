import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pagos de la suscripción cobrados con Wompi (links de pago).
 *
 * Una fila por INTENTO de compra: el dueño elige plan → se crea un link de pago
 * de un solo uso y se guarda aquí con el monto y los días que compra. Cuando
 * Wompi confirma la transacción (webhook, regreso del cliente o barrido), la
 * fila pasa a `approved` y, EN LA MISMA TRANSACCIÓN SQL, se le suman los días a
 * `subscriptions`. `applied_at` marca que los días ya se cargaron: es la llave
 * de la idempotencia (un webhook repetido no suma dos veces).
 *
 * Invariantes (en la BD, no solo en el código — aquí hay dinero real):
 *   - `reference` y `payment_link_id` únicos: cada link es de un solo pago.
 *   - `provider_transaction_id` único: una transacción de Wompi no puede cargar
 *     días en dos pagos distintos.
 *   - `approved` ⇔ `applied_at` NOT NULL: no existe un pago aprobado sin días
 *     cargados ni días cargados sin pago aprobado.
 *   - monto y días positivos.
 */
export class CreateSubscriptionPayments1747012980000 implements MigrationInterface {
  name = 'CreateSubscriptionPayments1747012980000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "subscription_payment_status" AS ENUM (
          'pending', 'approved', 'declined', 'voided', 'error', 'expired', 'needs_review'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "subscription_payments" (
        "id"                      bigserial   PRIMARY KEY,
        "reference"               uuid        NOT NULL DEFAULT gen_random_uuid(),
        "company_id"              bigint      NOT NULL,
        "subscription_id"         bigint      NOT NULL,
        "owner_user_id"           bigint      NOT NULL,
        "plan"                    "subscription_plan" NOT NULL,
        "amount_in_cents"         bigint      NOT NULL,
        "currency"                varchar(3)  NOT NULL DEFAULT 'COP',
        "days_granted"            integer     NOT NULL,
        "provider"                varchar(20) NOT NULL DEFAULT 'wompi',
        "provider_environment"    varchar(20) NOT NULL,
        "payment_link_id"         varchar(64) NOT NULL,
        "checkout_url"            text        NOT NULL,
        "link_expires_at"         timestamptz NOT NULL,
        "status"                  "subscription_payment_status" NOT NULL DEFAULT 'pending',
        "provider_transaction_id" varchar(64) NULL,
        "provider_status"         varchar(20) NULL,
        "provider_status_message" text        NULL,
        "payment_method_type"     varchar(40) NULL,
        "failure_reason"          text        NULL,
        "applied_at"              timestamptz NULL,
        "period_starts_at"        timestamptz NULL,
        "period_ends_at"          timestamptz NULL,
        "last_checked_at"         timestamptz NULL,
        "created_at"              timestamptz NOT NULL DEFAULT now(),
        "updated_at"              timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_subscription_payments_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "fk_subscription_payments_subscription_id" FOREIGN KEY ("subscription_id")
          REFERENCES "subscriptions" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "fk_subscription_payments_owner_user_id" FOREIGN KEY ("owner_user_id")
          REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "chk_subscription_payments_paid_plan" CHECK ("plan" <> 'free'),
        CONSTRAINT "chk_subscription_payments_amount_positive" CHECK ("amount_in_cents" > 0),
        CONSTRAINT "chk_subscription_payments_days_positive" CHECK ("days_granted" > 0),
        CONSTRAINT "chk_subscription_payments_approved_applied" CHECK (
          ("status" = 'approved') = ("applied_at" IS NOT NULL)
        ),
        CONSTRAINT "chk_subscription_payments_applied_period" CHECK (
          "applied_at" IS NULL OR ("period_starts_at" IS NOT NULL AND "period_ends_at" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_subscription_payments_reference_unique"
        ON "subscription_payments" ("reference")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_subscription_payments_payment_link_id_unique"
        ON "subscription_payments" ("payment_link_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_subscription_payments_transaction_id_unique"
        ON "subscription_payments" ("provider_transaction_id")
        WHERE "provider_transaction_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_subscription_payments_company_created"
        ON "subscription_payments" ("company_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_subscription_payments_unapplied"
        ON "subscription_payments" ("created_at")
        WHERE "applied_at" IS NULL
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "subscription_payments" IS
      'Pagos de la suscripción vía Wompi (link de pago de un solo uso). approved ⇔ applied_at: los días se cargan en la misma transacción que aprueba el pago.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "subscription_payments"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "subscription_payment_status"`);
  }
}
