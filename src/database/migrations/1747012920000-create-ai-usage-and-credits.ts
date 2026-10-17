import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Consumo y créditos de Place (asistente IA).
 *
 *   - `companies.ai_daily_credits`: preguntas diarias que la cuenta puede
 *     hacerle a Place. **0 por defecto = bloqueado**: toda cuenta necesita que
 *     se le asignen créditos desde el panel superadmin (decisión de producto).
 *   - `ai_daily_credit_usage`: mensajes usados por company y día (calendario
 *     de Colombia). La reserva es un único UPSERT condicionado → dos mensajes
 *     simultáneos nunca pasan el límite.
 *   - `ai_usage_events`: tokens que informó Gemini por cada pregunta (`chat`) y
 *     cada saludo (`greeting`). Alimenta el dashboard de consumo.
 */
export class CreateAiUsageAndCredits1747012920000 implements MigrationInterface {
  name = 'CreateAiUsageAndCredits1747012920000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "ai_daily_credits" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP CONSTRAINT IF EXISTS "chk_companies_ai_daily_credits_non_negative"
    `);
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD CONSTRAINT "chk_companies_ai_daily_credits_non_negative" CHECK ("ai_daily_credits" >= 0)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_daily_credit_usage" (
        "company_id" bigint  NOT NULL,
        "day"        date    NOT NULL,
        "messages"   integer NOT NULL DEFAULT 0,
        CONSTRAINT "pk_ai_daily_credit_usage" PRIMARY KEY ("company_id", "day"),
        CONSTRAINT "fk_ai_daily_credit_usage_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "chk_ai_daily_credit_usage_messages_non_negative" CHECK ("messages" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_usage_events" (
        "id"              bigserial   PRIMARY KEY,
        "company_id"      bigint      NOT NULL,
        "user_id"         bigint      NULL,
        "kind"            text        NOT NULL,
        "model"           text        NOT NULL,
        "prompt_tokens"   integer     NOT NULL DEFAULT 0,
        "output_tokens"   integer     NOT NULL DEFAULT 0,
        "thoughts_tokens" integer     NOT NULL DEFAULT 0,
        "cached_tokens"   integer     NOT NULL DEFAULT 0,
        "total_tokens"    integer     NOT NULL DEFAULT 0,
        "rounds"          smallint    NOT NULL DEFAULT 0,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_ai_usage_events_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "chk_ai_usage_events_kind" CHECK ("kind" IN ('chat', 'greeting')),
        CONSTRAINT "chk_ai_usage_events_tokens_non_negative" CHECK (
          "prompt_tokens" >= 0 AND "output_tokens" >= 0 AND "thoughts_tokens" >= 0
          AND "cached_tokens" >= 0 AND "total_tokens" >= 0 AND "rounds" >= 0
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ai_usage_events_company_created"
        ON "ai_usage_events" ("company_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ai_usage_events_created"
        ON "ai_usage_events" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_usage_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_daily_credit_usage"`);
    await queryRunner.query(`
      ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "chk_companies_ai_daily_credits_non_negative"
    `);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "ai_daily_credits"`);
  }
}
