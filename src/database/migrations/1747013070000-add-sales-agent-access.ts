import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — acceso por negocio y consumo de IA.
 *
 * 1) `companies.sales_agent_enabled`: interruptor del agente vendedor de ESTA
 *    company (principal o sucursal, cada una independiente). Apagado por
 *    defecto; se habilita desde el panel superadmin. Apagado = el agente no
 *    responde en ningún canal y su configuración queda inaccesible.
 *
 * 2) `ai_usage_events.kind` admite el consumo del agente, que suma a la IA de
 *    la cuenta: `sales_agent` (un mensaje atendido), `sales_agent_audio` (nota
 *    de voz transcrita) y `catalog_suggest` ("Completar con IA" de la ficha).
 */
export class AddSalesAgentAccess1747013070000 implements MigrationInterface {
  name = 'AddSalesAgentAccess1747013070000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "sales_agent_enabled" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "companies"."sales_agent_enabled" IS
      'Asistente de ventas (agente vendedor) habilitado para esta company. Se activa desde el panel superadmin.'
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_usage_events" DROP CONSTRAINT IF EXISTS "chk_ai_usage_events_kind"
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_usage_events" ADD CONSTRAINT "chk_ai_usage_events_kind"
        CHECK ("kind" IN ('chat', 'greeting', 'sales_agent', 'sales_agent_audio', 'catalog_suggest'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "ai_usage_events"
       WHERE "kind" IN ('sales_agent', 'sales_agent_audio', 'catalog_suggest')
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_usage_events" DROP CONSTRAINT IF EXISTS "chk_ai_usage_events_kind"
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_usage_events" ADD CONSTRAINT "chk_ai_usage_events_kind"
        CHECK ("kind" IN ('chat', 'greeting'))
    `);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "sales_agent_enabled"`);
  }
}
