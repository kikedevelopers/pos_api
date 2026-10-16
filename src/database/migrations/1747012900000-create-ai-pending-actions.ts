import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Operaciones de escritura que Place (el asistente IA) PREPARA y que solo se
 * ejecutan cuando el usuario las confirma en un mensaje posterior.
 *
 * Por qué una tabla y no un token en la conversación: el historial del chat
 * viaja como texto plano desde el cliente; lo que devuelve una herramienta no
 * sobrevive al siguiente turno. La operación pendiente tiene que vivir en el
 * servidor para que la confirmación ejecute EXACTAMENTE lo que el usuario vio.
 *
 *   - `action_type`          REGISTER_EXPENSE | VOID_EXPENSE.
 *   - `payload`              snapshot exacto de lo que se ejecutará (concepto,
 *                            valor, fuente / gasto a archivar).
 *   - `status`               PENDING → EXECUTED | SUPERSEDED | EXPIRED.
 *   - `request_id`           petición de chat que la preparó: la confirmación
 *                            se rechaza en esa misma petición (el modelo no
 *                            puede preparar y confirmar sin que el usuario
 *                            responda).
 *   - `trigger_message_hash` sha256 del mensaje del usuario que la originó: la
 *                            confirmación solo vale como respuesta inmediata a
 *                            ESE resumen, nunca a un "sí" posterior y ajeno.
 *   - `result_ref`           id del gasto creado/archivado (auditoría).
 *
 * El índice único parcial garantiza UNA pendiente por usuario y company: una
 * nueva preparación reemplaza (SUPERSEDED) la anterior.
 */
export class CreateAiPendingActions1747012900000 implements MigrationInterface {
  name = 'CreateAiPendingActions1747012900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_pending_actions" (
        "id"                   bigserial PRIMARY KEY,
        "company_id"           bigint      NOT NULL,
        "user_id"              bigint      NOT NULL,
        "action_type"          text        NOT NULL,
        "payload"              jsonb       NOT NULL,
        "status"               text        NOT NULL DEFAULT 'PENDING',
        "request_id"           uuid        NOT NULL,
        "trigger_message_hash" text        NOT NULL,
        "expires_at"           timestamptz NOT NULL,
        "result_ref"           bigint      NULL,
        "executed_at"          timestamptz NULL,
        "created_at"           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_ai_pending_actions_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "chk_ai_pending_actions_action_type"
          CHECK ("action_type" IN ('REGISTER_EXPENSE', 'VOID_EXPENSE')),
        CONSTRAINT "chk_ai_pending_actions_status"
          CHECK ("status" IN ('PENDING', 'EXECUTED', 'SUPERSEDED', 'EXPIRED')),
        CONSTRAINT "chk_ai_pending_actions_executed_consistency"
          CHECK (("status" = 'EXECUTED') = ("executed_at" IS NOT NULL))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_ai_pending_actions_one_pending"
        ON "ai_pending_actions" ("company_id", "user_id")
        WHERE "status" = 'PENDING'
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "ai_pending_actions" IS
      'Escrituras preparadas por Place (asistente IA) a la espera de la confirmación explícita del usuario.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_pending_actions"`);
  }
}
