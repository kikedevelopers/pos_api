import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cimientos del sistema de PUNTOS de cliente (paridad PlacePos
 * `1791000000000-AddCustomerPoints`):
 *
 *   - `customers.points` (integer default 0): saldo de puntos acumulados del
 *     cliente. Invariante: nunca negativo (`CK_customers_points_nonneg`).
 *   - `sale_invoices.points_awarded` (integer default 0): puntos otorgados por
 *     esa venta. Permite el modelo RECOMPUTE idempotente (recalcular el delta
 *     sobre lo ya otorgado en lugar de sumar a ciegas en cada anulación /
 *     edición).
 *
 * Aditiva e idempotente: `ADD COLUMN IF NOT EXISTS` + el CHECK se agrega solo
 * si no existe ya. No requiere índices nuevos: ambas columnas se leen / mutan
 * siempre por la PK de su fila (`customers.id`, `sale_invoices.id`), nunca en
 * un `WHERE`/`ORDER BY` propio.
 */
export class AddCustomerPoints1747011820000 implements MigrationInterface {
  name = 'AddCustomerPoints1747011820000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "customers"
      ADD COLUMN IF NOT EXISTS "points" integer NOT NULL DEFAULT 0
    `);

    // Idempotente: el constraint solo se agrega si no existe ya.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CK_customers_points_nonneg'
        ) THEN
          ALTER TABLE "customers"
          ADD CONSTRAINT "CK_customers_points_nonneg"
            CHECK ("points" >= 0);
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "sale_invoices"
      ADD COLUMN IF NOT EXISTS "points_awarded" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sale_invoices" DROP COLUMN IF EXISTS "points_awarded"
    `);

    await queryRunner.query(`
      ALTER TABLE "customers"
      DROP CONSTRAINT IF EXISTS "CK_customers_points_nonneg"
    `);

    await queryRunner.query(`
      ALTER TABLE "customers" DROP COLUMN IF EXISTS "points"
    `);
  }
}
