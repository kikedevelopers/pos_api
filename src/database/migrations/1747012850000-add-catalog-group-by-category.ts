import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Preferencia de presentación del catálogo público: agrupar por categoría.
 *
 * Cuando `catalog_group_by_category = true` la landing (`/catalog/<slug>`)
 * agrupa los productos por su categoría (con encabezados y un sidebar de
 * navegación por categoría); con `false` (default) se muestran en una sola
 * cuadrícula plana. Es una preferencia de cómo se PINTA el catálogo, no cambia
 * qué productos se exponen ni los permisos, así que viaja junto a
 * `catalog_slug`/`catalog_enabled` en `companies`.
 *
 * `NOT NULL DEFAULT false` evita backfill: todo negocio existente conserva la
 * cuadrícula plana que ya tenía.
 */
export class AddCatalogGroupByCategory1747012850000 implements MigrationInterface {
  name = 'AddCatalogGroupByCategory1747012850000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
      ADD COLUMN IF NOT EXISTS "catalog_group_by_category" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "companies"."catalog_group_by_category" IS
      'Catálogo público: agrupar productos por categoría (true) o cuadrícula plana (false, default).'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "catalog_group_by_category"
    `);
  }
}
