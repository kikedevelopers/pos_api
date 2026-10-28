import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cambio de plan programado en `subscriptions`.
 *
 * Con un plan de pago vigente ya no se compra otro plan encima: elegir otro
 * plan lo PROGRAMA (`scheduled_plan`) para cuando termine el período pagado.
 *
 * Además, un índice parcial sobre los pagos aprobados por período: el barrido
 * que promueve el plan al empezar un período ya pagado consulta por ahí.
 */
export class AddSubscriptionScheduledPlan1747012990000 implements MigrationInterface {
  name = 'AddSubscriptionScheduledPlan1747012990000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subscriptions"
        ADD COLUMN IF NOT EXISTS "scheduled_plan" "subscription_plan" NULL,
        ADD COLUMN IF NOT EXISTS "plan_scheduled_at" timestamptz NULL
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "subscriptions"
          ADD CONSTRAINT "chk_subscriptions_scheduled_plan_paid"
          CHECK ("scheduled_plan" IS NULL OR "scheduled_plan" <> 'free');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_subscription_payments_approved_period"
        ON "subscription_payments" ("subscription_id", "period_starts_at")
        WHERE "status" = 'approved'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_subscription_payments_approved_period"`);
    await queryRunner.query(`
      ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "chk_subscriptions_scheduled_plan_paid"
    `);
    await queryRunner.query(`
      ALTER TABLE "subscriptions"
        DROP COLUMN IF EXISTS "plan_scheduled_at",
        DROP COLUMN IF EXISTS "scheduled_plan"
    `);
  }
}
