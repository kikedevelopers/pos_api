import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recuperación de contraseña por correo.
 *
 * Mismo molde que `user_activation_tokens`: se guarda el SHA-256 del token y
 * nunca el valor en claro, de un solo uso (`used_at`) y con caducidad corta.
 *
 * La ventana es más corta que la de activación (horas, no días) porque este
 * token abre la puerta a CAMBIAR la contraseña de una cuenta viva: cuanto menos
 * tiempo exista, menos ventana hay si el buzón queda expuesto.
 */
export class AddPasswordResetTokens1747012340000 implements MigrationInterface {
  name = 'AddPasswordResetTokens1747012340000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
        "id"         bigserial PRIMARY KEY,
        "user_id"    bigint NOT NULL,
        "token_hash" text NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "used_at"    timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_password_reset_tokens_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_password_reset_tokens_token_hash"
      ON "password_reset_tokens" ("token_hash")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_password_reset_tokens_user_id"
      ON "password_reset_tokens" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_password_reset_tokens_user_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_password_reset_tokens_token_hash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "password_reset_tokens"`);
  }
}
