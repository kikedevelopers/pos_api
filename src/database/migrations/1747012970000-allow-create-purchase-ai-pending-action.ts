import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Place (asistente IA) ahora también PREPARA compras a proveedor a partir de
 * una factura (foto o PDF): `ai_pending_actions` acepta `CREATE_PURCHASE`.
 *
 * Mismo flujo que gastos, pedidos y tesorería: el snapshot exacto (proveedor,
 * líneas, costos) queda pendiente y solo se crea con el "sí" del usuario en un
 * mensaje posterior. `result_ref` = id de la compra creada.
 */
export class AllowCreatePurchaseAiPendingAction1747012970000 implements MigrationInterface {
  name = 'AllowCreatePurchaseAiPendingAction1747012970000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_pending_actions"
        DROP CONSTRAINT IF EXISTS "chk_ai_pending_actions_action_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_pending_actions"
        ADD CONSTRAINT "chk_ai_pending_actions_action_type"
        CHECK ("action_type" IN (
          'REGISTER_EXPENSE', 'VOID_EXPENSE', 'CREATE_SALE', 'TRANSFER_FUNDS', 'ADJUST_BALANCE',
          'CREATE_PURCHASE'
        ))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Las compras pendientes no sobreviven al rollback del tipo.
    await queryRunner.query(
      `DELETE FROM "ai_pending_actions" WHERE "action_type" = 'CREATE_PURCHASE'`,
    );
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
}
