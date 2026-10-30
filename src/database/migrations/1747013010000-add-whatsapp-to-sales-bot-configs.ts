import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Columnas de WhatsApp (Cloud API) en `sales_bot_configs`. El canal `whatsapp`
 * cuelga de UNA app de Meta (webhook único) y cada negocio solo configura el
 * número que registró bajo esa app:
 *   - `whatsapp_phone_number_id`: id del número (lo da Meta). Clave de ruteo del
 *     webhook al negocio correcto.
 *   - `whatsapp_access_token`: token propio del negocio (opcional). Si es NULL,
 *     el envío usa el token compartido de la app (WHATSAPP_ACCESS_TOKEN).
 *   - `whatsapp_waba_id`: id de la cuenta de WhatsApp Business (informativo).
 *
 * Son nullable y solo aplican a filas con channel = 'whatsapp'. No se añade un
 * CHECK por canal para no complicar; el servicio solo las escribe en ese canal.
 */
export class AddWhatsappToSalesBotConfigs1747013010000 implements MigrationInterface {
  name = 'AddWhatsappToSalesBotConfigs1747013010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_bot_configs"
        ADD COLUMN IF NOT EXISTS "whatsapp_phone_number_id" text NULL,
        ADD COLUMN IF NOT EXISTS "whatsapp_access_token"    text NULL,
        ADD COLUMN IF NOT EXISTS "whatsapp_waba_id"         text NULL
    `);
    // Un phone_number_id no puede estar en dos negocios a la vez (ruteo único).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_sales_bot_configs_wa_phone_number_id_unique"
        ON "sales_bot_configs" ("whatsapp_phone_number_id")
        WHERE "whatsapp_phone_number_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_sales_bot_configs_wa_phone_number_id_unique"`,
    );
    await queryRunner.query(`
      ALTER TABLE "sales_bot_configs"
        DROP COLUMN IF EXISTS "whatsapp_phone_number_id",
        DROP COLUMN IF EXISTS "whatsapp_access_token",
        DROP COLUMN IF EXISTS "whatsapp_waba_id"
    `);
  }
}
