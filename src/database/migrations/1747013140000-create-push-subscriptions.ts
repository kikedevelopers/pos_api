import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notificaciones push de la PWA (Web Push).
 *
 * `push_subscriptions`: una fila por navegador/dispositivo suscrito (el
 * `endpoint` del servicio push lo identifica). Guarda quién es y en qué negocio
 * estaba al suscribirse, para decidir en el envío si le toca el aviso (los
 * pedidos del agente son de nivel administrador; el dueño los recibe de todas
 * sus sucursales). Un endpoint que el servicio push da por muerto (404/410) se
 * borra al enviar.
 */
export class CreatePushSubscriptions1747013140000 implements MigrationInterface {
  name = 'CreatePushSubscriptions1747013140000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "push_subscriptions" (
        "id" bigserial PRIMARY KEY,
        "user_id" bigint NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        "company_id" bigint NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        "user_type" varchar(20) NOT NULL,
        "account" varchar(20) NOT NULL DEFAULT 'user',
        "endpoint" text NOT NULL,
        "p256dh" varchar(255) NOT NULL,
        "auth" varchar(255) NOT NULL,
        "user_agent" varchar(300) NULL,
        "last_success_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_push_subscriptions_endpoint"
        ON "push_subscriptions" ("endpoint")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_push_subscriptions_company"
        ON "push_subscriptions" ("company_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_push_subscriptions_user"
        ON "push_subscriptions" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "push_subscriptions"`);
  }
}
