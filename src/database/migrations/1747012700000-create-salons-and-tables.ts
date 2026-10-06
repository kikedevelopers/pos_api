import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Módulo "Salones y Mesas" (cloud-only, modo restaurante).
 *
 * Crea dos tablas por tenant:
 *
 *   - `salons`: un salón AGRUPA mesas (es como una categoría de mesas, p. ej.
 *     "Sur A"). Solo tiene nombre; no modela capacidad.
 *   - `restaurant_tables`: una mesa del restaurante. Tiene `name` + `seats`
 *     (nº de sillas) y, opcionalmente, pertenece a un salón (`salon_id`).
 *
 * --------------------------------------------------------------------------
 * Anclaje de mesa a salón (`owned_by_salon`)
 * --------------------------------------------------------------------------
 *
 *   - Mesa CREADA dentro de un salón → `owned_by_salon = true`: queda anclada
 *     de forma permanente. Al archivar el salón, estas mesas se archivan con él.
 *   - Mesa EXISTENTE anclada a un salón → `owned_by_salon = false`: al archivar
 *     el salón, solo se desancla (`salon_id = NULL`) y queda suelta de nuevo.
 *
 * `salon_id` lleva FK `ON DELETE SET NULL`: el flujo normal es archivar (soft),
 * pero si alguna vez se borrara físicamente un salón, sus mesas no se borran.
 *
 * --------------------------------------------------------------------------
 * `status` (free | occupied)
 * --------------------------------------------------------------------------
 *
 *   Preparado para el flujo de pedidos: una mesa queda OCUPADA al enviarle un
 *   pedido y se libera al cobrarlo. Default `free`. Este módulo solo administra
 *   el CRUD; la ocupación la gestionará el flujo de pedidos más adelante.
 *
 * Multi-tenancy: ambas tablas llevan `company_id bigint NOT NULL` + FK a
 * companies con `ON DELETE CASCADE` (borrar la company barre el tenant entero,
 * como el resto de tablas creadas tras `enable-tenant-cascade-delete`) + índice. UNIQUE per-company parcial sobre
 * `lower(btrim(name))` donde `is_archived = false` (archivar libera el nombre).
 * Auditoría `created_by` / `created_by_id` como en customer_categories.
 */
export class CreateSalonsAndTables1747012700000 implements MigrationInterface {
  name = 'CreateSalonsAndTables1747012700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ----------------------------------------------------------------------
    // salons
    // ----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "salons" (
        "id" bigserial PRIMARY KEY,
        "company_id" bigint NOT NULL,
        "name" text NOT NULL,
        "is_archived" boolean NOT NULL DEFAULT false,
        "created_by" text NULL,
        "created_by_id" bigint NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_salons_name_not_empty" CHECK (length(btrim(name)) > 0),
        CONSTRAINT "fk_salons_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_salons_company_id" ON "salons" ("company_id")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_salons_company_name_unique"
      ON "salons" ("company_id", lower(btrim(name)))
      WHERE is_archived = false
    `);

    // ----------------------------------------------------------------------
    // Enum de estado de la mesa (re-ejecutable).
    // ----------------------------------------------------------------------
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'restaurant_tables_status_enum') THEN
          CREATE TYPE "restaurant_tables_status_enum" AS ENUM ('free', 'occupied');
        END IF;
      END
      $$;
    `);

    // ----------------------------------------------------------------------
    // restaurant_tables
    // ----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "restaurant_tables" (
        "id" bigserial PRIMARY KEY,
        "company_id" bigint NOT NULL,
        "name" text NOT NULL,
        "seats" integer NOT NULL DEFAULT 1,
        "salon_id" bigint NULL,
        "owned_by_salon" boolean NOT NULL DEFAULT false,
        "status" "restaurant_tables_status_enum" NOT NULL DEFAULT 'free',
        "is_archived" boolean NOT NULL DEFAULT false,
        "created_by" text NULL,
        "created_by_id" bigint NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_restaurant_tables_name_not_empty" CHECK (length(btrim(name)) > 0),
        CONSTRAINT "chk_restaurant_tables_seats_positive" CHECK (seats > 0),
        CONSTRAINT "fk_restaurant_tables_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "fk_restaurant_tables_salon_id" FOREIGN KEY ("salon_id")
          REFERENCES "salons" ("id") ON DELETE SET NULL ON UPDATE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_restaurant_tables_company_id"
      ON "restaurant_tables" ("company_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_restaurant_tables_salon_id"
      ON "restaurant_tables" ("salon_id")
      WHERE salon_id IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_restaurant_tables_company_name_unique"
      ON "restaurant_tables" ("company_id", lower(btrim(name)))
      WHERE is_archived = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "idx_restaurant_tables_company_name_unique"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_restaurant_tables_salon_id"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_restaurant_tables_company_id"');
    await queryRunner.query('DROP TABLE IF EXISTS "restaurant_tables"');
    await queryRunner.query('DROP TYPE IF EXISTS "restaurant_tables_status_enum"');

    await queryRunner.query('DROP INDEX IF EXISTS "idx_salons_company_name_unique"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_salons_company_id"');
    await queryRunner.query('DROP TABLE IF EXISTS "salons"');
  }
}
