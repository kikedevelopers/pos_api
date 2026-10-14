import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Catálogo público por tenant.
 *
 * El negocio puede publicar un catálogo web de solo lectura (precios de venta)
 * accesible desde la landing en `/catalog/<slug>` para compartir con sus
 * clientes. Dos columnas en `companies` (es identidad/gate de negocio, no una
 * preferencia de POS, así que va junto a `ai_enabled`/`electronic_billing_enabled`
 * y no en `app_settings`):
 *
 *   - `catalog_slug`: el "nombre de usuario" público del catálogo. UNA sola
 *     palabra en minúsculas, solo `[a-z0-9]` (sin espacios, acentos ni símbolos),
 *     p. ej. `esenciaygrano`. UNIQUE GLOBAL (índice parcial, igual que
 *     `employees.username`) porque es la llave de la URL pública: dos negocios no
 *     pueden compartir slug. Nullable: un negocio sin catálogo no tiene slug.
 *   - `catalog_enabled`: GATE. Con `false` (default) la ruta pública responde
 *     404 aunque el slug exista — el negocio controla cuándo publica.
 *
 * El CHECK del formato admite NULL (sin slug) o la palabra válida. `NOT NULL
 * DEFAULT false` en el flag evita backfill.
 */
export class AddCompanyCatalog1747012840000 implements MigrationInterface {
  name = 'AddCompanyCatalog1747012840000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
      ADD COLUMN IF NOT EXISTS "catalog_slug" text
    `);

    await queryRunner.query(`
      ALTER TABLE "companies"
      ADD COLUMN IF NOT EXISTS "catalog_enabled" boolean NOT NULL DEFAULT false
    `);

    // Formato del slug: NULL (sin catálogo) o una sola palabra [a-z0-9] de 3 a 30
    // caracteres. Blindaje en DB — el service normaliza/valida igual antes de
    // escribir, pero el CHECK impide que una ruta manual/migración deje basura.
    await queryRunner.query(`
      ALTER TABLE "companies"
      ADD CONSTRAINT "chk_companies_catalog_slug_format"
      CHECK ("catalog_slug" IS NULL OR "catalog_slug" ~ '^[a-z0-9]{3,30}$')
    `);

    // UNIQUE global solo cuando hay slug (índice parcial, mismo precedente que
    // idx_employees_username_unique): dos negocios no pueden compartir la URL.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_companies_catalog_slug_unique"
      ON "companies" ("catalog_slug")
      WHERE "catalog_slug" IS NOT NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "companies"."catalog_slug" IS
      'Slug público del catálogo (una palabra [a-z0-9], UNIQUE global). NULL = sin catálogo.'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "companies"."catalog_enabled" IS
      'Gate del catálogo público. false = la ruta /catalog/<slug> responde 404 (default).'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_companies_catalog_slug_unique"
    `);
    await queryRunner.query(`
      ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "chk_companies_catalog_slug_format"
    `);
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "catalog_enabled"
    `);
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "catalog_slug"
    `);
  }
}
