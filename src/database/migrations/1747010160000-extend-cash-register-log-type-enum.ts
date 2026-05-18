import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 3.5 — Extender `cash_register_log_type` con los valores PlacePos y
 * añadir las columnas de enlace que la Fase 4 (sales / credit-notes) requiere.
 *
 * --------------------------------------------------------------------------
 * Cambios al enum
 * --------------------------------------------------------------------------
 *
 *   - DROP valores no usados: `CASH_IN`, `CASH_OUT`, `COUNT`. La realineación
 *     consolida la semántica granular de PlacePos (cada operación tiene su
 *     tipo: `CASH_RECEIVED`, `CASH_PAYMENT`, `EXPENSE`, etc.).
 *   - ADD valores PlacePos: `CASH_RECEIVED`, `CASH_PAYMENT`, `CASH_CHANGE`,
 *     `CREDIT_PAYMENT`, `CREDIT_NOTE_FULL_VOID`, `CREDIT_NOTE_PARTIAL_VOID`,
 *     `DEBIT_NOTE`, `CARRIER_PAYMENT`, `EXPENSE`, `VOID_EXPENSE`, `REFUND`,
 *     `PURCHASE_PAYMENT`, `ADMIN_ADJUSTMENT`, `CASH_OVERAGE`, `CASH_SHORTAGE`.
 *   - Conservados: `CASH_TRANSFER_IN`, `CASH_TRANSFER_OUT`.
 *
 * pos_api no está en producción → DROP TYPE … CASCADE recrea limpio. Estrategia:
 * dropear default + cambiar columna a `text` temporal, dropear el tipo,
 * recrearlo con los nuevos valores, casting de vuelta.
 *
 * --------------------------------------------------------------------------
 * Columnas nuevas en `cash_register_logs`
 * --------------------------------------------------------------------------
 *
 *   - `invoice_id bigint NULL` FK opcional a `sale_invoices(id) ON DELETE
 *     SET NULL`. Espejo PlacePos: vincula el log con la venta que lo generó
 *     (`CASH_RECEIVED`, `CASH_PAYMENT`, `CASH_CHANGE`).
 *   - `payment_id bigint NULL` FK opcional a `sale_payments(id) ON DELETE
 *     SET NULL`. Espejo PlacePos.
 *   - `credit_note_id bigint NULL` FK opcional a `credit_notes(id) ON DELETE
 *     SET NULL`. Espejo PlacePos.
 *   - `is_credit_related boolean NOT NULL DEFAULT false`. Bandera derivada
 *     que el frontend usa para filtrar logs por flujos de crédito sin tener
 *     que correlacionar `type`.
 *
 * Todas son nullable porque la mayoría de logs NO viven en el contexto de un
 * recurso concreto (ej. `ADMIN_ADJUSTMENT`, `CASH_TRANSFER_*`).
 */
export class ExtendCashRegisterLogTypeEnum1747010160000 implements MigrationInterface {
  name = 'ExtendCashRegisterLogTypeEnum1747010160000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Renombrar el tipo viejo para no chocar nombres.
    await queryRunner.query(
      `ALTER TYPE "cash_register_log_type" RENAME TO "cash_register_log_type_old"`,
    );

    // 2. Crear el tipo nuevo con todos los valores PlacePos.
    await queryRunner.query(`
      CREATE TYPE "cash_register_log_type" AS ENUM (
        'CASH_RECEIVED',
        'CASH_PAYMENT',
        'CASH_CHANGE',
        'CREDIT_PAYMENT',
        'CREDIT_NOTE_FULL_VOID',
        'CREDIT_NOTE_PARTIAL_VOID',
        'DEBIT_NOTE',
        'CARRIER_PAYMENT',
        'EXPENSE',
        'VOID_EXPENSE',
        'REFUND',
        'PURCHASE_PAYMENT',
        'CASH_TRANSFER_OUT',
        'CASH_TRANSFER_IN',
        'ADMIN_ADJUSTMENT',
        'CASH_OVERAGE',
        'CASH_SHORTAGE'
      )
    `);

    // 3. Cast la columna a text intermedio para evitar errores de unknown enum value
    //    cuando hay rows con CASH_IN / CASH_OUT / COUNT (pos_api en dev puede tener
    //    datos seed). Mapeamos al equivalente PlacePos para preservar continuidad:
    //
    //      CASH_IN  → ADMIN_ADJUSTMENT  (entrada genérica anterior)
    //      CASH_OUT → ADMIN_ADJUSTMENT  (salida genérica anterior)
    //      COUNT    → ADMIN_ADJUSTMENT  (no equivalente directo; el "conteo" cabe en ajuste)
    //
    //    Si no había rows con esos valores el UPDATE es no-op.
    await queryRunner.query(`
      ALTER TABLE "cash_register_logs"
      ALTER COLUMN "type" TYPE text USING "type"::text
    `);
    await queryRunner.query(`
      UPDATE "cash_register_logs"
      SET "type" = 'ADMIN_ADJUSTMENT'
      WHERE "type" IN ('CASH_IN', 'CASH_OUT', 'COUNT')
    `);

    // 4. Convertir a enum nuevo.
    await queryRunner.query(`
      ALTER TABLE "cash_register_logs"
      ALTER COLUMN "type" TYPE "cash_register_log_type" USING "type"::"cash_register_log_type"
    `);

    // 5. Drop tipo viejo.
    await queryRunner.query(`DROP TYPE "cash_register_log_type_old"`);

    // 6. Añadir columnas de enlace.
    await queryRunner.query(`
      ALTER TABLE "cash_register_logs"
      ADD COLUMN "invoice_id" bigint NULL,
      ADD COLUMN "payment_id" bigint NULL,
      ADD COLUMN "credit_note_id" bigint NULL,
      ADD COLUMN "is_credit_related" boolean NOT NULL DEFAULT false
    `);

    // 7. FKs opcionales — ON DELETE SET NULL para preservar el log histórico
    //    aunque el recurso referenciado sea borrado lógicamente.
    await queryRunner.query(`
      ALTER TABLE "cash_register_logs"
      ADD CONSTRAINT "fk_cash_register_logs_invoice_id"
      FOREIGN KEY ("invoice_id") REFERENCES "sale_invoices" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "cash_register_logs"
      ADD CONSTRAINT "fk_cash_register_logs_payment_id"
      FOREIGN KEY ("payment_id") REFERENCES "sale_payments" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "cash_register_logs"
      ADD CONSTRAINT "fk_cash_register_logs_credit_note_id"
      FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
    `);

    // 8. Índices parciales para queries de "logs de una venta / pago / nota".
    await queryRunner.query(`
      CREATE INDEX "idx_cash_register_logs_invoice"
      ON "cash_register_logs" ("invoice_id")
      WHERE "invoice_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_cash_register_logs_payment"
      ON "cash_register_logs" ("payment_id")
      WHERE "payment_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_cash_register_logs_credit_note"
      ON "cash_register_logs" ("credit_note_id")
      WHERE "credit_note_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 8/7/6. Drop índices, FKs y columnas nuevas.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cash_register_logs_credit_note"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cash_register_logs_payment"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cash_register_logs_invoice"`);
    await queryRunner.query(
      `ALTER TABLE "cash_register_logs" DROP CONSTRAINT IF EXISTS "fk_cash_register_logs_credit_note_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_register_logs" DROP CONSTRAINT IF EXISTS "fk_cash_register_logs_payment_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_register_logs" DROP CONSTRAINT IF EXISTS "fk_cash_register_logs_invoice_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_register_logs"
       DROP COLUMN IF EXISTS "is_credit_related",
       DROP COLUMN IF EXISTS "credit_note_id",
       DROP COLUMN IF EXISTS "payment_id",
       DROP COLUMN IF EXISTS "invoice_id"`,
    );

    // 5/4/3/2/1. Restaurar enum viejo.
    await queryRunner.query(
      `ALTER TYPE "cash_register_log_type" RENAME TO "cash_register_log_type_old"`,
    );
    await queryRunner.query(`
      CREATE TYPE "cash_register_log_type" AS ENUM (
        'CASH_IN',
        'CASH_OUT',
        'CASH_TRANSFER_IN',
        'CASH_TRANSFER_OUT',
        'COUNT'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "cash_register_logs"
      ALTER COLUMN "type" TYPE text USING "type"::text
    `);
    // Cualquier valor que el up agregó y que el enum viejo no soporta,
    // colapsa a 'CASH_IN' (down de emergencia — datos perdidos son tolerables
    // porque pos_api no está en producción).
    await queryRunner.query(`
      UPDATE "cash_register_logs"
      SET "type" = 'CASH_IN'
      WHERE "type" NOT IN ('CASH_IN', 'CASH_OUT', 'CASH_TRANSFER_IN', 'CASH_TRANSFER_OUT', 'COUNT')
    `);
    await queryRunner.query(`
      ALTER TABLE "cash_register_logs"
      ALTER COLUMN "type" TYPE "cash_register_log_type" USING "type"::"cash_register_log_type"
    `);
    await queryRunner.query(`DROP TYPE "cash_register_log_type_old"`);
  }
}
