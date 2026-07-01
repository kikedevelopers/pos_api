import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HISTORIAL DE ESTADOS de una venta — paridad placepos.
 *
 * --------------------------------------------------------------------------
 * Qué crea
 * --------------------------------------------------------------------------
 *
 *   1. Enum Postgres `sale_status_event_type`
 *      (CREATED | COLLECTED | CREDIT_OPENED | INSTALLMENT | PAID | VOIDED).
 *   2. Tabla `sale_status_history` (append-only) con `company_id` (multi-tenant),
 *      `sale_invoice_id` (FK CASCADE), `event_type`, `amount` NULLABLE,
 *      `created_by` snapshot y `created_at` timestamptz.
 *   3. FKs a `companies` (RESTRICT) y `sale_invoices` (CASCADE) + índices.
 *
 * --------------------------------------------------------------------------
 * BACKFILL idempotente de las ventas existentes
 * --------------------------------------------------------------------------
 *
 * Reconstruye la línea de tiempo de las ventas ya registradas. Corre SOLO si la
 * tabla está vacía (guard `IF NOT EXISTS (SELECT 1 ...)`) para que un re-run de
 * la migración no duplique eventos. El orden de los INSERT asigna ids crecientes
 * que respetan la secuencia lógica (CREATED < COLLECTED/INSTALLMENT <
 * CREDIT_OPENED < PAID < VOIDED) — desempate estable cuando dos eventos comparten
 * `created_at` (mismo instante de una TX histórica).
 *
 *   - `CREATED`       por cada `sale_invoices` (created_at/created_by de la venta).
 *   - `COLLECTED`     por cada `sale_payments` vivo cuya venta NO tiene crédito.
 *   - `INSTALLMENT`   por cada `sale_payments` vivo cuya venta SÍ tiene crédito.
 *   - `CREDIT_OPENED` por cada `sale_credits` (amount = total del crédito).
 *   - `PAID`          por cada `sale_credits` con status PAID (created_at = updated_at).
 *   - `VOIDED`        por cada `sale_invoices` con is_deleted=true (created_at de la
 *                     NC FULL_VOID viva si existe; si no, el updated_at de la venta).
 *
 * --------------------------------------------------------------------------
 * down()
 * --------------------------------------------------------------------------
 *
 * Reversible por completo: DROP TABLE + DROP TYPE. El historial es derivable
 * (backfill), así que perderlo en un rollback no destruye información maestra.
 */
export class CreateSaleStatusHistoryTable1747011980000 implements MigrationInterface {
  name = 'CreateSaleStatusHistoryTable1747011980000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Enum (idempotente).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sale_status_event_type') THEN
          CREATE TYPE "sale_status_event_type" AS ENUM (
            'CREATED', 'COLLECTED', 'CREDIT_OPENED', 'INSTALLMENT', 'PAID', 'VOIDED'
          );
        END IF;
      END $$;
    `);

    // 2. Tabla.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sale_status_history" (
        "id"              bigserial PRIMARY KEY,
        "company_id"      bigint NOT NULL,
        "sale_invoice_id" bigint NOT NULL,
        "event_type"      "sale_status_event_type" NOT NULL,
        "amount"          numeric(15,2) NULL,
        "created_by"      text NULL,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_sale_status_history_company_id"
          FOREIGN KEY ("company_id") REFERENCES "companies" ("id")
          ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT "fk_sale_status_history_sale_invoice_id"
          FOREIGN KEY ("sale_invoice_id") REFERENCES "sale_invoices" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    // 3. Índices.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sale_status_history_company_id"
      ON "sale_status_history" ("company_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sale_status_history_invoice_created"
      ON "sale_status_history" ("sale_invoice_id", "created_at")
    `);

    // 4. BACKFILL idempotente (solo si la tabla está vacía).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM "sale_status_history") THEN

          -- CREATED: una por venta/pedido.
          INSERT INTO "sale_status_history"
            (company_id, sale_invoice_id, event_type, amount, created_by, created_at)
          SELECT si.company_id, si.id, 'CREATED', NULL, si.created_by, si.created_at
          FROM "sale_invoices" si;

          -- COLLECTED / INSTALLMENT: por cada pago VIVO. Si la venta tiene
          -- crédito → INSTALLMENT (abono); si no → COLLECTED (cobro/conversión).
          INSERT INTO "sale_status_history"
            (company_id, sale_invoice_id, event_type, amount, created_by, created_at)
          SELECT
            sp.company_id,
            sp.sale_invoice_id,
            (CASE WHEN sc.id IS NULL THEN 'COLLECTED' ELSE 'INSTALLMENT' END)::"sale_status_event_type",
            sp.amount,
            sp.created_by,
            sp.created_at
          FROM "sale_payments" sp
          LEFT JOIN "sale_credits" sc
            ON sc.sale_invoice_id = sp.sale_invoice_id
           AND sc.company_id = sp.company_id
          WHERE sp.is_voided = false;

          -- CREDIT_OPENED: por cada crédito (amount = total del crédito).
          INSERT INTO "sale_status_history"
            (company_id, sale_invoice_id, event_type, amount, created_by, created_at)
          SELECT sc.company_id, sc.sale_invoice_id, 'CREDIT_OPENED', sc.total_amount,
                 si.created_by, sc.created_at
          FROM "sale_credits" sc
          JOIN "sale_invoices" si
            ON si.id = sc.sale_invoice_id
           AND si.company_id = sc.company_id;

          -- PAID: por cada crédito saldado (created_at = updated_at del crédito).
          INSERT INTO "sale_status_history"
            (company_id, sale_invoice_id, event_type, amount, created_by, created_at)
          SELECT sc.company_id, sc.sale_invoice_id, 'PAID', NULL, NULL, sc.updated_at
          FROM "sale_credits" sc
          WHERE sc.status = 'PAID';

          -- VOIDED: por cada venta anulada. created_at = NC FULL_VOID viva si
          -- existe; si no, el updated_at de la venta.
          INSERT INTO "sale_status_history"
            (company_id, sale_invoice_id, event_type, amount, created_by, created_at)
          SELECT
            si.company_id,
            si.id,
            'VOIDED',
            NULL,
            COALESCE(cn.created_by, si.created_by),
            COALESCE(cn.created_at, si.updated_at)
          FROM "sale_invoices" si
          LEFT JOIN LATERAL (
            SELECT c.created_at, c.created_by
            FROM "credit_notes" c
            WHERE c.sale_invoice_id = si.id
              AND c.company_id = si.company_id
              AND c.operation_type = 'FULL_VOID'
              AND c.is_deleted = false
            ORDER BY c.created_at DESC
            LIMIT 1
          ) cn ON true
          WHERE si.is_deleted = true;

        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sale_status_history"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "sale_status_event_type"`);
  }
}
