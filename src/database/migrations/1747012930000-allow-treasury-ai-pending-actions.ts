import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Place (asistente IA) ahora también PREPARA movimientos de tesorería:
 * `ai_pending_actions` acepta `TRANSFER_FUNDS` (mover saldo entre cajas,
 * bancos y billeteras) y `ADJUST_BALANCE` (corregir el saldo de una cuenta a
 * un valor objetivo), además de gastos y pedidos.
 *
 * Mismo flujo: el snapshot exacto (cuentas, monto, saldo visto) queda
 * pendiente y solo se ejecuta con el "sí" del usuario en un mensaje posterior.
 * `result_ref` (un id) queda en NULL: las cuentas afectadas viven en el `payload`.
 */
export class AllowTreasuryAiPendingActions1747012930000 implements MigrationInterface {
  name = 'AllowTreasuryAiPendingActions1747012930000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_pending_actions"
        DROP CONSTRAINT IF EXISTS "chk_ai_pending_actions_action_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_pending_actions"
        ADD CONSTRAINT "chk_ai_pending_actions_action_type"
        CHECK ("action_type" IN (
          'REGISTER_EXPENSE', 'VOID_EXPENSE', 'CREATE_SALE', 'TRANSFER_FUNDS', 'ADJUST_BALANCE'
        ))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Las pendientes de tesorería no sobreviven al rollback del tipo.
    await queryRunner.query(
      `DELETE FROM "ai_pending_actions" WHERE "action_type" IN ('TRANSFER_FUNDS', 'ADJUST_BALANCE')`,
    );
    await queryRunner.query(`
      ALTER TABLE "ai_pending_actions"
        DROP CONSTRAINT IF EXISTS "chk_ai_pending_actions_action_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_pending_actions"
        ADD CONSTRAINT "chk_ai_pending_actions_action_type"
        CHECK ("action_type" IN ('REGISTER_EXPENSE', 'VOID_EXPENSE', 'CREATE_SALE'))
    `);
  }
}
