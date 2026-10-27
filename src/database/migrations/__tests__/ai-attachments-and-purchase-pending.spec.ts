import type { QueryRunner } from 'typeorm';

import { CreateAiAttachments1747012960000 } from '../1747012960000-create-ai-attachments';
import { AllowCreatePurchaseAiPendingAction1747012970000 } from '../1747012970000-allow-create-purchase-ai-pending-action';

const buildRunner = (): { runner: QueryRunner; calls: () => string[] } => {
  const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
  return {
    runner: { query } as unknown as QueryRunner,
    calls: () => query.mock.calls.map((call) => String(call[0])),
  };
};

/**
 * `ai_attachments` es la frontera multi-tenant de los archivos de Place: el
 * Files API de Google es de la llave del servidor, así que la tabla DEBE atar
 * cada archivo a su company/usuario y nunca guardar los bytes.
 */
describe('CreateAiAttachments1747012960000', () => {
  const migration = new CreateAiAttachments1747012960000();

  it('crea la tabla con dueño (company + usuario), sin columna de bytes', async () => {
    const { runner, calls } = buildRunner();
    await migration.up(runner);

    const sql = calls().join('\n');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "ai_attachments"/);
    expect(sql).toMatch(/"company_id"\s+bigint\s+NOT NULL/);
    expect(sql).toMatch(/"user_id"\s+bigint\s+NOT NULL/);
    expect(sql).toMatch(/REFERENCES "companies" \("id"\) ON UPDATE CASCADE ON DELETE CASCADE/);
    expect(sql).toMatch(/"gemini_file_uri"\s+text\s+NOT NULL/);
    expect(sql).not.toMatch(/bytea/i);
  });

  it('solo admite fotos y PDF, y vence después de crearse', async () => {
    const { runner, calls } = buildRunner();
    await migration.up(runner);

    const sql = calls().join('\n');
    expect(sql).toMatch(
      /'image\/jpeg', 'image\/png', 'image\/webp', 'image\/heic', 'image\/heif', 'application\/pdf'/,
    );
    expect(sql).toMatch(/CHECK \("size_bytes" > 0\)/);
    expect(sql).toMatch(/CHECK \("expires_at" > "created_at"\)/);
    expect(sql).toMatch(/idx_ai_attachments_company_user/);
  });

  it('la bajada elimina la tabla', async () => {
    const { runner, calls } = buildRunner();
    await migration.down(runner);
    expect(calls()).toEqual([expect.stringMatching(/DROP TABLE IF EXISTS "ai_attachments"/)]);
  });
});

describe('AllowCreatePurchaseAiPendingAction1747012970000', () => {
  const migration = new AllowCreatePurchaseAiPendingAction1747012970000();

  it('la subida conserva todos los tipos anteriores y agrega CREATE_PURCHASE', async () => {
    const { runner, calls } = buildRunner();
    await migration.up(runner);

    const sql = calls().join('\n');
    for (const type of [
      'REGISTER_EXPENSE',
      'VOID_EXPENSE',
      'CREATE_SALE',
      'TRANSFER_FUNDS',
      'ADJUST_BALANCE',
      'CREATE_PURCHASE',
    ]) {
      expect(sql).toContain(`'${type}'`);
    }
    expect(sql).not.toMatch(/DELETE/i);
  });

  it('la bajada borra las compras pendientes ANTES de restaurar el CHECK viejo', async () => {
    const { runner, calls } = buildRunner();
    await migration.down(runner);

    const statements = calls();
    const delete_index = statements.findIndex((sql) =>
      /DELETE FROM "ai_pending_actions" WHERE "action_type" = 'CREATE_PURCHASE'/.test(sql),
    );
    const add_index = statements.findIndex((sql) => /ADD CONSTRAINT/.test(sql));
    expect(delete_index).toBeGreaterThanOrEqual(0);
    expect(delete_index).toBeLessThan(add_index);
    expect(statements[add_index]).toContain("'ADJUST_BALANCE'");
    expect(statements[add_index]).not.toContain('CREATE_PURCHASE');
  });
});
