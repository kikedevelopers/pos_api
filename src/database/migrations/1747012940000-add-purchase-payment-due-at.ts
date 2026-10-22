import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plazo de pago de las compras: `purchases.payment_due_at` guarda el instante
 * en que vence el pago al proveedor, siempre el FINAL del día elegido en
 * Bogotá (23:59:59.999). NULL = compra sin plazo — así quedan TODAS las
 * compras existentes (no hay backfill: nadie tenía plazo antes).
 *
 *   - CHECK: el plazo nunca vence antes de la creación de la compra.
 *   - Índice parcial `(company_id, payment_due_at)` para las consultas de
 *     "por vencer / vencidas" por negocio.
 */
export class AddPurchasePaymentDueAt1747012940000 implements MigrationInterface {
  name = 'AddPurchasePaymentDueAt1747012940000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "purchases"
        ADD COLUMN IF NOT EXISTS "payment_due_at" TIMESTAMPTZ NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "purchases"
        DROP CONSTRAINT IF EXISTS "chk_purchases_payment_due_after_creation"
    `);
    await queryRunner.query(`
      ALTER TABLE "purchases"
        ADD CONSTRAINT "chk_purchases_payment_due_after_creation"
        CHECK ("payment_due_at" IS NULL OR "payment_due_at" >= "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_purchases_company_payment_due"
        ON "purchases" ("company_id", "payment_due_at")
        WHERE "payment_due_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_purchases_company_payment_due"`);
    await queryRunner.query(`
      ALTER TABLE "purchases"
        DROP CONSTRAINT IF EXISTS "chk_purchases_payment_due_after_creation"
    `);
    await queryRunner.query(`ALTER TABLE "purchases" DROP COLUMN IF EXISTS "payment_due_at"`);
  }
}
