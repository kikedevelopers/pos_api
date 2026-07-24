import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea `agreement_acceptances`: registro genérico de aceptaciones de acuerdos
 * (disclaimers / T&C) por usuario. El contenido de cada acuerdo vive en el
 * front (por `agreement_key` + `version`); esta tabla solo guarda quién aceptó
 * qué y en qué versión. UNIQUE `(company_id, user_id, account, agreement_key)`:
 * una fila por usuario y acuerdo (se actualiza al re-aceptar).
 */
export class CreateAgreementAcceptancesTable1747012200000
  implements MigrationInterface
{
  name = 'CreateAgreementAcceptancesTable1747012200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agreement_acceptances" (
        "id"            bigserial PRIMARY KEY,
        "company_id"    bigint NOT NULL,
        "user_id"       bigint NOT NULL,
        "account"       text NOT NULL,
        "agreement_key" text NOT NULL,
        "version"       integer NOT NULL DEFAULT 1,
        "accepted_at"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_agreement_acceptances_company_id"
          FOREIGN KEY ("company_id") REFERENCES "companies" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_agreement_acceptances_company_id"
      ON "agreement_acceptances" ("company_id")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_agreement_acceptances_user_agreement"
      ON "agreement_acceptances" ("company_id", "user_id", "account", "agreement_key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."uq_agreement_acceptances_user_agreement"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_agreement_acceptances_company_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "agreement_acceptances"`);
  }
}
