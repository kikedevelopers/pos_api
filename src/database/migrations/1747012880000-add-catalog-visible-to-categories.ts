import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Visibilidad de una CATEGORÍA completa en el catálogo público.
 *
 *   - `catalog_visible`: si los productos de la categoría aparecen en
 *     `/catalog/<slug>`. `false` excluye la categoría entera del catálogo web
 *     (sin tocar el flag por producto ni el POS). `true` por defecto → todas
 *     las categorías existentes siguen visibles (sin backfill).
 */
export class AddCatalogVisibleToCategories1747012880000 implements MigrationInterface {
  name = 'AddCatalogVisibleToCategories1747012880000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "categories"
        ADD COLUMN IF NOT EXISTS "catalog_visible" boolean NOT NULL DEFAULT true
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "categories"."catalog_visible" IS
      'Catálogo público: los productos de la categoría aparecen en /catalog/<slug> (default true).'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "categories" DROP COLUMN IF EXISTS "catalog_visible"
    `);
  }
}
