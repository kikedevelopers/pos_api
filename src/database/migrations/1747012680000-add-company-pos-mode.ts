import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Modo del Punto de Venta por negocio: `retail` (el POS de siempre) o
 * `restaurant` (POS dedicado a restaurantes y bares, con mesas/salones).
 *
 * Se cambia desde el panel superadmin (kdevs-admin) y viaja en el perfil del
 * login; el cliente Electron lo usa para decidir qué ventana de POS abrir.
 *
 * Columna en `companies` (no en el owner) porque el modo es del NEGOCIO: una
 * sucursal puede ser un restaurante aunque el principal sea una tienda.
 *
 * `NOT NULL DEFAULT 'retail'`: todas las companies existentes quedan con el POS
 * actual sin necesidad de backfill — nada cambia hasta que alguien lo active.
 */
export class AddCompanyPosMode1747012680000 implements MigrationInterface {
  name = 'AddCompanyPosMode1747012680000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // CREATE TYPE no admite IF NOT EXISTS: se protege con el catálogo para que
    // la migración sea re-ejecutable.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'companies_pos_mode_enum') THEN
          CREATE TYPE "companies_pos_mode_enum" AS ENUM ('retail', 'restaurant');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "companies"
      ADD COLUMN IF NOT EXISTS "pos_mode" "companies_pos_mode_enum" NOT NULL DEFAULT 'retail'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "companies"."pos_mode" IS
      'Modo del POS del negocio: retail (default, POS de siempre) | restaurant (mesas/salones). Lo cambia el panel superadmin; el cliente lo lee del perfil para elegir la ventana de POS.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "pos_mode"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "companies_pos_mode_enum"`);
  }
}
