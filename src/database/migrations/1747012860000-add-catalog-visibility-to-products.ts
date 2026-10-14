import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Flags de catálogo público a nivel de PRODUCTO (y presentación: son filas de
 * la misma tabla `products`).
 *
 *   - `catalog_visible`: si el producto aparece en el catálogo web
 *     `/catalog/<slug>`. `true` por defecto → todos los productos existentes,
 *     incluidos combos, quedan visibles (sin backfill). Es independiente de
 *     `show_in_pos` (visibilidad en el POS del negocio).
 *   - `catalog_out_of_stock`: el negocio marca el producto como fuera de stock.
 *     Sigue apareciendo en el catálogo pero atenuado y como "No disponible".
 *     `false` por defecto (disponible).
 *
 * `NOT NULL DEFAULT` evita backfill, igual que `show_in_pos`/`use_parent_image`.
 */
export class AddCatalogVisibilityToProducts1747012860000 implements MigrationInterface {
  name = 'AddCatalogVisibilityToProducts1747012860000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "products"
        ADD COLUMN IF NOT EXISTS "catalog_visible" boolean NOT NULL DEFAULT true
    `);
    await queryRunner.query(`
      ALTER TABLE "products"
        ADD COLUMN IF NOT EXISTS "catalog_out_of_stock" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "products"."catalog_visible" IS
      'Catálogo público: el producto/presentación aparece en /catalog/<slug> (default true).'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "products"."catalog_out_of_stock" IS
      'Catálogo público: marcado fuera de stock, visible pero no disponible (default false).'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "products" DROP COLUMN IF EXISTS "catalog_out_of_stock"
    `);
    await queryRunner.query(`
      ALTER TABLE "products" DROP COLUMN IF EXISTS "catalog_visible"
    `);
  }
}
