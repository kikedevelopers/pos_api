import type { QueryRunner } from 'typeorm';

import { AddCompanyAiEnabled1747012820000 } from '../1747012820000-add-company-ai-enabled';

/**
 * Gate de acceso al asistente Place por cuenta. Lo crítico de la migración es
 * que NO le dé acceso a nadie por accidente: toda company existente debe quedar
 * con `ai_enabled = false` sin backfill, y la bajada debe poder revertirla.
 */
describe('AddCompanyAiEnabled1747012820000', () => {
  const buildRunner = (): { runner: QueryRunner; sql: () => string } => {
    const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
    return {
      runner: { query } as unknown as QueryRunner,
      sql: () => query.mock.calls.map((call) => String(call[0])).join('\n'),
    };
  };

  const migration = new AddCompanyAiEnabled1747012820000();

  it('añade la columna NOT NULL con default false (nadie queda habilitado)', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);

    expect(sql()).toMatch(
      /ADD COLUMN IF NOT EXISTS "ai_enabled" boolean NOT NULL DEFAULT false/,
    );
  });

  it('es re-ejecutable (IF NOT EXISTS) y no hace backfill', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);

    expect(sql()).toMatch(/IF NOT EXISTS "ai_enabled"/);
    expect(sql()).not.toMatch(/UPDATE/i);
  });

  it('la bajada elimina la columna', async () => {
    const { runner, sql } = buildRunner();
    await migration.down(runner);

    expect(sql()).toMatch(/DROP COLUMN IF EXISTS "ai_enabled"/);
  });
});
