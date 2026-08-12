import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Activación de cuenta por correo.
 *
 *   - `users.activated_at`: cuándo se activó la cuenta. NULL = sin activar, y
 *     el login la rechaza. Solo aplica a los owners que se registran por su
 *     cuenta; empleados y usuarios espejo nacen activados.
 *
 *   - `user_activation_tokens`: los enlaces del correo de bienvenida. Se guarda
 *     el SHA-256 del token, nunca el token en claro: si alguien lee la tabla,
 *     no puede activar cuentas ajenas. Un solo uso (`used_at`) y con caducidad.
 *
 * BACKFILL: todas las cuentas que ya existen quedan activadas (`now()`). Nadie
 * que hoy puede entrar se queda fuera por este cambio — la exigencia empieza a
 * regir solo para los registros nuevos.
 */
export class AddAccountActivation1747012320000 implements MigrationInterface {
  name = 'AddAccountActivation1747012320000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "activated_at" timestamptz NULL
    `);

    // Backfill: lo que ya existía sigue funcionando exactamente igual.
    await queryRunner.query(`
      UPDATE "users" SET "activated_at" = now() WHERE "activated_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_activation_tokens" (
        "id"         bigserial PRIMARY KEY,
        "user_id"    bigint NOT NULL,
        "token_hash" text NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "used_at"    timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_user_activation_tokens_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    // El lookup del endpoint de activación es por hash: único, porque dos
    // tokens con el mismo hash serían el mismo token.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_activation_tokens_token_hash"
      ON "user_activation_tokens" ("token_hash")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_user_activation_tokens_user_id"
      ON "user_activation_tokens" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_user_activation_tokens_user_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_user_activation_tokens_token_hash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_activation_tokens"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "activated_at"`);
  }
}
