import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Interruptor de Facturación Electrónica (FE) por negocio.
 *
 * La FE NO viene activa por defecto: cada negocio la habilita explícitamente
 * desde el panel superadmin (kdevs-admin). Este flag es solo el GATE de
 * activación — el negocio con FE encendida es el que podrá emitir documentos
 * electrónicos. TODO el proceso de FE (armado del payload, firma y envío a la
 * DIAN) lo ejecuta el API externo de Laravel (APIDIAN); pos_api solo guarda la
 * configuración del negocio y decide si la FE está activa o no.
 *
 * Se guarda como columna en `companies` porque la FE es identidad del NEGOCIO
 * (NIT, resolución, prefijo…). Por ahora solo el booleano; la configuración
 * fiscal restante se irá sumando a este mismo terreno en fases siguientes.
 *
 * `NOT NULL DEFAULT false` para que todas las companies existentes queden con
 * la FE apagada sin necesidad de backfill.
 */
export class AddCompanyElectronicBillingEnabled1747012520000 implements MigrationInterface {
  name = 'AddCompanyElectronicBillingEnabled1747012520000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
      ADD COLUMN IF NOT EXISTS "electronic_billing_enabled" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "companies"."electronic_billing_enabled" IS
      'Gate de Facturación Electrónica del negocio. false = apagada (default). El proceso de FE lo ejecuta el API externo (APIDIAN); esto solo habilita la emisión.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "electronic_billing_enabled"
    `);
  }
}
