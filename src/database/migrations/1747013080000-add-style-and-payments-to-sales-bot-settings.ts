import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — personalización por negocio:
 *  - Estilo propio del dueño por etapa de la venta (saludo, asesoría, cierre).
 *  - Formas de pago que acepta el negocio (el agente solo ofrece esas) e
 *    indicaciones de pago (cuentas, datáfono...).
 *
 * El default de `payment_methods` (efectivo + transferencia) es lo que el
 * agente ofrecía antes, así que los negocios existentes no cambian.
 */
export class AddStyleAndPaymentsToSalesBotSettings1747013080000 implements MigrationInterface {
  name = 'AddStyleAndPaymentsToSalesBotSettings1747013080000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings"
        ADD COLUMN IF NOT EXISTS "greeting_style" text NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS "selling_style" text NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS "closing_style" text NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS "payment_methods" text[] NOT NULL DEFAULT '{cash,bank_transfer}',
        ADD COLUMN IF NOT EXISTS "payment_instructions" text NOT NULL DEFAULT ''
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sales_bot_settings"
          ADD CONSTRAINT "chk_sales_bot_settings_payment_methods" CHECK (
            cardinality("payment_methods") >= 1
            AND "payment_methods" <@ ARRAY['cash', 'bank_transfer', 'debit_card', 'credit_card']::text[]
          );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sales_bot_settings"
          ADD CONSTRAINT "chk_sales_bot_settings_style_len" CHECK (
            length("greeting_style") <= 500
            AND length("selling_style") <= 500
            AND length("closing_style") <= 500
          );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sales_bot_settings"
          ADD CONSTRAINT "chk_sales_bot_settings_payment_instructions_len"
          CHECK (length("payment_instructions") <= 300);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings"
        DROP CONSTRAINT IF EXISTS "chk_sales_bot_settings_payment_instructions_len",
        DROP CONSTRAINT IF EXISTS "chk_sales_bot_settings_style_len",
        DROP CONSTRAINT IF EXISTS "chk_sales_bot_settings_payment_methods",
        DROP COLUMN IF EXISTS "payment_instructions",
        DROP COLUMN IF EXISTS "payment_methods",
        DROP COLUMN IF EXISTS "closing_style",
        DROP COLUMN IF EXISTS "selling_style",
        DROP COLUMN IF EXISTS "greeting_style"
    `);
  }
}
