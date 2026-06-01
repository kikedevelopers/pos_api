import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `origin VARCHAR(32) NOT NULL DEFAULT 'web'` a la tabla `companies`.
 *
 * Distingue cómo se creó la cuenta cloud:
 *   - `'web'`              → registro normal vía `POST /auth/register`.
 *   - `'offline_migration'`→ la cuenta se creó DESDE un POS offline (placepos)
 *     en su primera migración a "modo cloud". Estas cuentas arrancan con un
 *     trial más corto (`SUBSCRIPTION_MIGRATION_DAYS = 1` día en vez de 10).
 *
 * Seguro para companies existentes: el `DEFAULT 'web'` marca todas las filas
 * previas como registro normal sin necesidad de un backfill explícito. Se usa
 * `IF NOT EXISTS` para que la migración sea idempotente.
 *
 * Se modela como VARCHAR con CHECK (no como `enum` nativo de Postgres) por
 * paridad con el resto del esquema, que prefiere CHECK constraints sobre tipos
 * enum para evitar el coste de `ALTER TYPE` al ampliar valores en el futuro.
 */
export class AddOriginToCompanies1747011260000 implements MigrationInterface {
  name = 'AddOriginToCompanies1747011260000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS origin VARCHAR(32) NOT NULL DEFAULT 'web'
    `);

    // Postgres no soporta `ADD CONSTRAINT IF NOT EXISTS` para CHECK, así que
    // guardamos contra `pg_constraint` para que el `up()` sea realmente idempotente.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_companies_origin'
        ) THEN
          ALTER TABLE companies
          ADD CONSTRAINT chk_companies_origin
          CHECK (origin IN ('web', 'offline_migration'));
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_origin
    `);
    await queryRunner.query(`
      ALTER TABLE companies DROP COLUMN IF EXISTS origin
    `);
  }
}
