import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — ENTREGAS que ofrece el negocio.
 *
 * Antes el agente deducía la entrega de la dirección del negocio: sin dirección,
 * asumía "todo a domicilio" y pedía dirección aunque el negocio no hiciera envíos.
 * Ahora el dueño lo dice explícitamente:
 *   - `delivery_modes`: `pickup` (recogen en el negocio) y/o `delivery`
 *     (domicilio); al menos uno.
 *   - `pickup_address`: dónde se recoge; vacío = la dirección del negocio.
 */
export class AddDeliveryToSalesBotSettings1747013100000 implements MigrationInterface {
  name = 'AddDeliveryToSalesBotSettings1747013100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings"
        ADD COLUMN IF NOT EXISTS "delivery_modes" text[] NOT NULL DEFAULT '{pickup,delivery}',
        ADD COLUMN IF NOT EXISTS "pickup_address" text NOT NULL DEFAULT ''
    `);
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings"
        DROP CONSTRAINT IF EXISTS "chk_sales_bot_settings_delivery_modes"
    `);
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings" ADD CONSTRAINT "chk_sales_bot_settings_delivery_modes"
        CHECK (cardinality("delivery_modes") >= 1 AND "delivery_modes" <@ ARRAY['pickup', 'delivery']::text[])
    `);
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings"
        DROP CONSTRAINT IF EXISTS "chk_sales_bot_settings_pickup_address_len"
    `);
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings" ADD CONSTRAINT "chk_sales_bot_settings_pickup_address_len"
        CHECK (length("pickup_address") <= 250)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings"
        DROP CONSTRAINT IF EXISTS "chk_sales_bot_settings_pickup_address_len",
        DROP CONSTRAINT IF EXISTS "chk_sales_bot_settings_delivery_modes",
        DROP COLUMN IF EXISTS "pickup_address",
        DROP COLUMN IF EXISTS "delivery_modes"
    `);
  }
}
