import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Place (asistente IA) ahora también PREPARA pedidos: `ai_pending_actions`
 * acepta el tipo `CREATE_SALE` (además de los de gastos).
 *
 * El flujo es el mismo de los gastos: la herramienta deja la operación
 * pendiente con el snapshot exacto del pedido (cliente, líneas, precios,
 * totales) y solo se ejecuta con el "sí" del usuario en un mensaje posterior.
 * `result_ref` guarda el id de la venta (pedido) creada.
 */
export class AllowCreateSaleAiPendingAction1747012910000 implements MigrationInterface {
  name = 'AllowCreateSaleAiPendingAction1747012910000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Las pendientes de pedido no sobreviven al rollback del tipo.
    await queryRunner.query(`DELETE FROM "ai_pending_actions" WHERE "action_type" = 'CREATE_SALE'`);
    await queryRunner.query(`
      ALTER TABLE "ai_pending_actions"
        DROP CONSTRAINT IF EXISTS "chk_ai_pending_actions_action_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_pending_actions"
        ADD CONSTRAINT "chk_ai_pending_actions_action_type"
        CHECK ("action_type" IN ('REGISTER_EXPENSE', 'VOID_EXPENSE'))
    `);
  }
}
