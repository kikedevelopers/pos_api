import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — filtro de mensajes FUERA DE TEMA (anti-troll).
 *
 * Quien escribe solo para molestar (drogas, sexo, provocaciones, preguntas sin
 * sentido) quema tokens del negocio. El agente marca cada mensaje fuera de tema;
 * al llegar al límite se despide y la conversación queda EN SILENCIO: los
 * mensajes ya no pasan por el agente (un clasificador mínimo decide si vuelve a
 * ser algo del negocio, y solo entonces responde).
 *
 *   - `sales_bot_conversations.off_topic_strikes`: mensajes fuera de tema
 *     seguidos (un mensaje del negocio lo reinicia).
 *   - `sales_bot_conversations.muted_at`: desde cuándo está en silencio.
 *   - `sales_bot_settings.off_topic_limit`: cuántos antes de despedirse
 *     (0 = filtro apagado). Default 3.
 */
export class AddOffTopicGuardToSalesAgent1747013130000 implements MigrationInterface {
  name = 'AddOffTopicGuardToSalesAgent1747013130000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_bot_conversations"
        ADD COLUMN IF NOT EXISTS "off_topic_strikes" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "muted_at" timestamptz NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings"
        ADD COLUMN IF NOT EXISTS "off_topic_limit" integer NOT NULL DEFAULT 3
    `);
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings"
        DROP CONSTRAINT IF EXISTS "chk_sales_bot_settings_off_topic_limit"
    `);
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings" ADD CONSTRAINT "chk_sales_bot_settings_off_topic_limit"
        CHECK ("off_topic_limit" BETWEEN 0 AND 10)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings"
        DROP CONSTRAINT IF EXISTS "chk_sales_bot_settings_off_topic_limit",
        DROP COLUMN IF EXISTS "off_topic_limit"
    `);
    await queryRunner.query(`
      ALTER TABLE "sales_bot_conversations"
        DROP COLUMN IF EXISTS "muted_at",
        DROP COLUMN IF EXISTS "off_topic_strikes"
    `);
  }
}
