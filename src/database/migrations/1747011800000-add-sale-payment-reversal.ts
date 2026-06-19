import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Feature "eliminar/reversar un pago de venta" — paridad placepos.
 *
 * --------------------------------------------------------------------------
 * Cambios
 * --------------------------------------------------------------------------
 *
 *   1. `sale_payments`: 6 columnas nuevas para el soft-delete (reverso) de un
 *      pago individual:
 *        - `is_voided    boolean NOT NULL DEFAULT false`
 *        - `voided_at    timestamptz NULL`
 *        - `voided_by    text NULL`         (snapshot nombre del actor)
 *        - `voided_by_id bigint NULL`       (id del actor)
 *        - `void_reason  text NULL`
 *        - `void_uuid    text NULL`         (idempotencia del reverso)
 *      + índice único parcial `(company_id, void_uuid) WHERE void_uuid IS NOT NULL`
 *        — blinda contra doble-reverso por reintento de red.
 *
 *   2. Enum Postgres `movement_concept`: añade `PAYMENT_REVERSAL` (lo emite el
 *      FinancialMovement(EXPENSE) que reversa un pago por banco/wallet).
 *
 *   3. Enum Postgres `cash_register_log_type`: añade `PAYMENT_REVERSAL` (lo
 *      emite el CashRegisterLog(OUT) que reversa un pago en efectivo).
 *
 * --------------------------------------------------------------------------
 * Por qué `transaction = false`
 * --------------------------------------------------------------------------
 *
 * Postgres prohíbe `ALTER TYPE … ADD VALUE` dentro de un bloque de transacción
 * (error 25001). TypeORM envuelve la migración en una TX por defecto; con
 * `transaction = false` cada statement corre autónomo. Las operaciones DDL de
 * columnas/índices son idempotentes (`IF NOT EXISTS`) por si la migración se
 * reintenta tras fallar a mitad.
 *
 * --------------------------------------------------------------------------
 * `down()` parcialmente irreversible
 * --------------------------------------------------------------------------
 *
 * Las columnas y el índice se revierten. Los valores de enum NO se eliminan
 * (Postgres no soporta `DROP VALUE`); el down los deja como no-op documentado
 * — consistente con `1747010460000-extend-movement-concept-enum`.
 */
export class AddSalePaymentReversal1747011800000 implements MigrationInterface {
  name = 'AddSalePaymentReversal1747011800000';

  // `ALTER TYPE ... ADD VALUE` no puede correr dentro de TX.
  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Columnas de reverso en sale_payments (idempotentes).
    await queryRunner.query(`
      ALTER TABLE "sale_payments"
        ADD COLUMN IF NOT EXISTS "is_voided" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "voided_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "voided_by" text NULL,
        ADD COLUMN IF NOT EXISTS "voided_by_id" bigint NULL,
        ADD COLUMN IF NOT EXISTS "void_reason" text NULL,
        ADD COLUMN IF NOT EXISTS "void_uuid" text NULL
    `);

    // Índice único parcial sobre void_uuid: idempotencia del reverso
    // (un mismo client_operation_id no puede reversar dos veces el pago).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_sale_payments_company_void_uuid_unique"
      ON "sale_payments" ("company_id", "void_uuid")
      WHERE "void_uuid" IS NOT NULL
    `);

    // Índice parcial para excluir rápido los pagos reversados en las
    // agregaciones de reportes (recaudo / cierre / dashboard).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sale_payments_company_active"
      ON "sale_payments" ("company_id", "sale_invoice_id")
      WHERE "is_voided" = false
    `);

    // 2. Enum movement_concept ← PAYMENT_REVERSAL.
    await queryRunner.query(
      `ALTER TYPE "movement_concept" ADD VALUE IF NOT EXISTS 'PAYMENT_REVERSAL'`,
    );

    // 3. Enum cash_register_log_type ← PAYMENT_REVERSAL.
    await queryRunner.query(
      `ALTER TYPE "cash_register_log_type" ADD VALUE IF NOT EXISTS 'PAYMENT_REVERSAL'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sale_payments_company_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sale_payments_company_void_uuid_unique"`);
    await queryRunner.query(`
      ALTER TABLE "sale_payments"
        DROP COLUMN IF EXISTS "void_uuid",
        DROP COLUMN IF EXISTS "void_reason",
        DROP COLUMN IF EXISTS "voided_by_id",
        DROP COLUMN IF EXISTS "voided_by",
        DROP COLUMN IF EXISTS "voided_at",
        DROP COLUMN IF EXISTS "is_voided"
    `);
    // Los valores de enum 'PAYMENT_REVERSAL' NO se eliminan (Postgres no
    // soporta DROP VALUE). No-op intencional — ver JSDoc.
  }
}
