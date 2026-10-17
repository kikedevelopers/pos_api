import type { QueryRunner } from 'typeorm';

import { AllowCreateSaleAiPendingAction1747012910000 } from '../1747012910000-allow-create-sale-ai-pending-action';

/**
 * El CHECK de `ai_pending_actions.action_type` es la última barrera contra un
 * tipo de operación desconocido. La subida debe sumar `CREATE_SALE` SIN perder
 * los tipos de gastos, y la bajada debe volver al conjunto anterior limpiando
 * antes las pendientes de pedido (si no, el CHECK viejo fallaría).
 */
describe('AllowCreateSaleAiPendingAction1747012910000', () => {
  const buildRunner = (): { runner: QueryRunner; calls: () => string[] } => {
    const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
    return {
      runner: { query } as unknown as QueryRunner,
      calls: () => query.mock.calls.map((call) => String(call[0])),
    };
  };

  const migration = new AllowCreateSaleAiPendingAction1747012910000();

  it('la subida conserva los tipos de gastos y agrega CREATE_SALE', async () => {
    const { runner, calls } = buildRunner();
    await migration.up(runner);

    const sql = calls().join('\n');
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS "chk_ai_pending_actions_action_type"/);
    expect(sql).toMatch(/IN \('REGISTER_EXPENSE', 'VOID_EXPENSE', 'CREATE_SALE'\)/);
    expect(sql).not.toMatch(/DELETE/i);
  });

  it('la bajada borra las pendientes de pedido ANTES de restaurar el CHECK viejo', async () => {
    const { runner, calls } = buildRunner();
    await migration.down(runner);

    const statements = calls();
    const delete_index = statements.findIndex((sql) =>
      /DELETE FROM "ai_pending_actions"/.test(sql),
    );
    const add_index = statements.findIndex((sql) => /ADD CONSTRAINT/.test(sql));
    expect(delete_index).toBeGreaterThanOrEqual(0);
    expect(delete_index).toBeLessThan(add_index);
    expect(statements[add_index]).toMatch(/IN \('REGISTER_EXPENSE', 'VOID_EXPENSE'\)/);
    expect(statements[add_index]).not.toMatch(/CREATE_SALE/);
  });
});
