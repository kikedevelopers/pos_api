import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ola B-1 — Añade `carrier_id`, `transport_cost`, `total_kilos` y refresca
 * `carrier_name` a `purchases`. Paridad con PlacePos `Purchase`:
 *
 *   - `carrier_id`     BIGINT NULL  FK carriers(id) RESTRICT.
 *   - `transport_cost` NUMERIC(15,2) NOT NULL DEFAULT 0 (CHECK >= 0).
 *   - `total_kilos`    NUMERIC(15,4) NULL (CHECK total_kilos IS NULL OR total_kilos >= 0).
 *   - `carrier_name`   ya existía en la tabla original como snapshot del
 *     receptor (`received_by_carrier`); reusamos la misma columna para
 *     guardar el snapshot del transportista al momento de crear la compra.
 *
 * Multi-tenant: NO podemos forzar a nivel de DB que el carrier pertenezca
 * a la misma company que la compra (PG no admite cross-row CHECK en FK).
 * La validación vive en `create-purchase.action.ts` / `update-purchase.action.ts`
 * (`carrier.company_id = purchase.company_id`).
 *
 * Índice: `(company_id, carrier_id) WHERE is_deleted = false` — soporta
 * reportes por transportista (cartera viva).
 */
export class AddCarrierFieldsToPurchases1747010900000 implements MigrationInterface {
  name = 'AddCarrierFieldsToPurchases1747010900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "purchases"
      ADD COLUMN "carrier_id" bigint NULL,
      ADD COLUMN "transport_cost" numeric(15, 2) NOT NULL DEFAULT 0,
      ADD COLUMN "total_kilos" numeric(15, 4) NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "purchases"
      ADD CONSTRAINT "fk_purchases_carrier_id"
      FOREIGN KEY ("carrier_id") REFERENCES "carriers"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "purchases"
      ADD CONSTRAINT "chk_purchases_transport_cost_non_negative"
      CHECK ("transport_cost" >= 0)
    `);

    await queryRunner.query(`
      ALTER TABLE "purchases"
      ADD CONSTRAINT "chk_purchases_total_kilos_non_negative"
      CHECK ("total_kilos" IS NULL OR "total_kilos" >= 0)
    `);

    // Coherencia: si transport_cost > 0, debe existir carrier_id. Si
    // transport_cost = 0, el carrier_id puede ser cualquiera (incluso NULL).
    // No exigimos carrier_name porque puede generarse a partir del snapshot.
    await queryRunner.query(`
      ALTER TABLE "purchases"
      ADD CONSTRAINT "chk_purchases_carrier_required_when_transport"
      CHECK (
        "transport_cost" = 0
        OR "carrier_id" IS NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_purchases_company_carrier_active"
      ON "purchases" ("company_id", "carrier_id")
      WHERE "is_deleted" = false AND "carrier_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_purchases_company_carrier_active"`);
    await queryRunner.query(
      `ALTER TABLE "purchases" DROP CONSTRAINT IF EXISTS "chk_purchases_carrier_required_when_transport"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchases" DROP CONSTRAINT IF EXISTS "chk_purchases_total_kilos_non_negative"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchases" DROP CONSTRAINT IF EXISTS "chk_purchases_transport_cost_non_negative"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchases" DROP CONSTRAINT IF EXISTS "fk_purchases_carrier_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "purchases"
      DROP COLUMN IF EXISTS "total_kilos",
      DROP COLUMN IF EXISTS "transport_cost",
      DROP COLUMN IF EXISTS "carrier_id"
    `);
  }
}
