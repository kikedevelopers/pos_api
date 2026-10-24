import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nuevo tipo de negocio `lender` (prestamistas) en `companies.pos_mode`.
 *
 * Solo AGREGA un valor al enum: ninguna company cambia de modo; todas siguen
 * en el que tenían hasta que el panel superadmin elija "Prestamistas".
 *
 * `ADD VALUE IF NOT EXISTS` la hace re-ejecutable. En Postgres 12+ puede ir
 * dentro de la transacción de la migración (el valor nuevo no se usa en ella).
 *
 * `down`: Postgres no sabe quitar un valor de un enum. Se devuelven los
 * prestamistas a `retail` (el modo por defecto) y se reconstruye el tipo sin
 * `lender`, conservando el default de la columna.
 */
export class AddLenderPosMode1747012950000 implements MigrationInterface {
  name = 'AddLenderPosMode1747012950000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "companies_pos_mode_enum" ADD VALUE IF NOT EXISTS 'lender'`);

    await queryRunner.query(`
      COMMENT ON COLUMN "companies"."pos_mode" IS
      'Tipo de negocio: retail (default, POS de siempre) | restaurant (mesas/salones) | lender (prestamistas, sin POS). Lo cambia el panel superadmin; el cliente lo lee del perfil.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "companies" SET "pos_mode" = 'retail' WHERE "pos_mode" = 'lender'`);
    await queryRunner.query(`ALTER TABLE "companies" ALTER COLUMN "pos_mode" DROP DEFAULT`);
    await queryRunner.query(`ALTER TYPE "companies_pos_mode_enum" RENAME TO "companies_pos_mode_enum_old"`);
    await queryRunner.query(`CREATE TYPE "companies_pos_mode_enum" AS ENUM ('retail', 'restaurant')`);
    await queryRunner.query(`
      ALTER TABLE "companies"
      ALTER COLUMN "pos_mode" TYPE "companies_pos_mode_enum"
      USING "pos_mode"::text::"companies_pos_mode_enum"
    `);
    await queryRunner.query(`ALTER TABLE "companies" ALTER COLUMN "pos_mode" SET DEFAULT 'retail'`);
    await queryRunner.query(`DROP TYPE "companies_pos_mode_enum_old"`);
  }
}
