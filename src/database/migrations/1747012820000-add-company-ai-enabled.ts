import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Interruptor de acceso al asistente **Place** (IA) por negocio.
 *
 * Place NO viene activo por defecto: cada cuenta se habilita explícitamente
 * desde el panel superadmin (kdevs-admin). Este flag es el GATE de acceso — con
 * él en `false`, pos_api rechaza `/ai/chat` (403 AI_NOT_ENABLED), reporta
 * `enabled:false` en `/ai/status` y no genera saludo; el cliente oculta el botón
 * del asistente y bloquea la navegación a la ruta del chat.
 *
 * Se guarda en `companies` porque el acceso es por NEGOCIO (su tenant): todos
 * los usuarios de esa company comparten el permiso.
 *
 * `NOT NULL DEFAULT false` para que todas las companies existentes queden con
 * Place apagado sin necesidad de backfill.
 */
export class AddCompanyAiEnabled1747012820000 implements MigrationInterface {
  name = 'AddCompanyAiEnabled1747012820000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
      ADD COLUMN IF NOT EXISTS "ai_enabled" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "companies"."ai_enabled" IS
      'Gate de acceso al asistente Place (IA). false = sin acceso (default). Se habilita por cuenta desde el panel superadmin.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "ai_enabled"
    `);
  }
}
