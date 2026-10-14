import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Imagen de portada (hero) del catálogo público.
 *
 * `companies.catalog_cover_image` guarda la RUTA del objeto en el bucket de GCS
 * (`inventory_items/<company_id>/catalog-cover-<aleatorio>.<ext>`, misma carpeta
 * que las imágenes de inventario para reutilizar el proxy firmado y el borrado
 * por tenant). `null` = sin portada → la landing muestra el hero por defecto.
 * La URL pública NO se guarda: se firma (proxy HMAC) en lectura.
 */
export class AddCompanyCatalogCover1747012870000 implements MigrationInterface {
  name = 'AddCompanyCatalogCover1747012870000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
      ADD COLUMN IF NOT EXISTS "catalog_cover_image" text
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "companies"."catalog_cover_image" IS
      'Ruta en GCS de la imagen de portada del catálogo público. NULL = sin portada.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "catalog_cover_image"
    `);
  }
}
