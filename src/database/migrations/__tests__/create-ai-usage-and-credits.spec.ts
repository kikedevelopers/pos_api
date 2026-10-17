import type { QueryRunner } from 'typeorm';

import { CreateAiUsageAndCredits1747012920000 } from '../1747012920000-create-ai-usage-and-credits';

/**
 * Créditos de Place: toda cuenta arranca BLOQUEADA (0 créditos, decisión de
 * producto) y la base no admite créditos ni consumos negativos.
 */
describe('CreateAiUsageAndCredits1747012920000', () => {
  const buildRunner = (): { runner: QueryRunner; sql: () => string } => {
    const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
    return {
      runner: { query } as unknown as QueryRunner,
      sql: () => query.mock.calls.map((call) => String(call[0])).join('\n'),
    };
  };
  const migration = new CreateAiUsageAndCredits1747012920000();

  it('créditos en 0 por defecto, no negativos, y sin backfill', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    expect(sql()).toMatch(/"ai_daily_credits" integer NOT NULL DEFAULT 0/);
    expect(sql()).toMatch(/CHECK \("ai_daily_credits" >= 0\)/);
    expect(sql()).not.toMatch(/UPDATE "companies"/);
  });

  it('crea el contador diario (PK company+día) y el registro de consumo con cascada', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    expect(sql()).toMatch(/PRIMARY KEY \("company_id", "day"\)/);
    expect(sql()).toMatch(/CREATE TABLE IF NOT EXISTS "ai_usage_events"/);
    expect(sql()).toMatch(/ON DELETE CASCADE/);
    expect(sql()).toMatch(/"kind" IN \('chat', 'greeting'\)/);
    expect(sql()).toMatch(/idx_ai_usage_events_company_created/);
  });

  it('la bajada elimina tablas y columna', async () => {
    const { runner, sql } = buildRunner();
    await migration.down(runner);
    expect(sql()).toMatch(/DROP TABLE IF EXISTS "ai_usage_events"/);
    expect(sql()).toMatch(/DROP TABLE IF EXISTS "ai_daily_credit_usage"/);
    expect(sql()).toMatch(/DROP COLUMN IF EXISTS "ai_daily_credits"/);
  });
});
