import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plan y estado de cobro de la suscripción.
 *
 * Hasta ahora `subscriptions` solo sabía CUÁNDO vence. Con el portal de la
 * landing el dueño puede ver y cambiar su plan, y necesita que le digan POR QUÉ
 * está vencida: no es lo mismo "se acabó la prueba" que "el pago no se pudo
 * procesar". Un solo booleano derivado de `expires_at` no puede decir eso.
 *
 *   - `plan`: lo que el negocio tiene HOY. `free` es la prueba inicial — no hay
 *     plan sin plan: una cuenta recién registrada es `free`, no "ninguno".
 *   - `status`: el estado del COBRO, no de la vigencia. La vigencia se sigue
 *     leyendo de `expires_at` (única fuente de la verdad del bloqueo, para no
 *     tener dos datos que puedan contradecirse). `status` explica el porqué.
 *   - `requested_plan` + `plan_requested_at`: el plan que el dueño pidió y
 *     todavía no ha pagado. Se guarda aparte de `plan` a propósito: pedir un
 *     plan no es tenerlo, y mezclarlos regalaría plan pago a quien solo hizo
 *     clic.
 *
 * BACKFILL: todo lo que existe queda `free` + `trialing`, que es exactamente lo
 * que esas cuentas son hoy (prueba de 10 días). Nadie cambia de estado por esta
 * migración.
 */
export class AddSubscriptionPlanAndStatus1747012400000 implements MigrationInterface {
  name = 'AddSubscriptionPlanAndStatus1747012400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enums nativos (regla 2.5 del proyecto). `IF NOT EXISTS` no existe para
    // CREATE TYPE, así que se consulta el catálogo — la migración tiene que
    // poder re-correrse sin explotar.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_plan') THEN
          CREATE TYPE "subscription_plan" AS ENUM ('free', 'monthly', 'annual');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
          CREATE TYPE "subscription_status" AS ENUM (
            'trialing',
            'active',
            'payment_pending',
            'payment_failed',
            'canceled'
          );
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "subscriptions"
      ADD COLUMN IF NOT EXISTS "plan" "subscription_plan" NOT NULL DEFAULT 'free',
      ADD COLUMN IF NOT EXISTS "status" "subscription_status" NOT NULL DEFAULT 'trialing',
      ADD COLUMN IF NOT EXISTS "requested_plan" "subscription_plan" NULL,
      ADD COLUMN IF NOT EXISTS "plan_requested_at" timestamptz NULL
    `);

    // El panel de kdevs y el barrido de cobros pendientes filtran por estado.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_subscriptions_status"
      ON "subscriptions" ("status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_subscriptions_status"`);
    await queryRunner.query(`
      ALTER TABLE "subscriptions"
      DROP COLUMN IF EXISTS "plan_requested_at",
      DROP COLUMN IF EXISTS "requested_plan",
      DROP COLUMN IF EXISTS "status",
      DROP COLUMN IF EXISTS "plan"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "subscription_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "subscription_plan"`);
  }
}
