import type { QueryRunner } from 'typeorm';

import { AddCompanyPosMode1747012680000 } from '../1747012680000-add-company-pos-mode';

/**
 * El modo del POS decide qué ventana de venta abre el cliente. Lo crítico de la
 * migración es que NO le cambie el POS a nadie: toda company existente debe
 * quedar en `retail` sin que haga falta un backfill.
 */
describe('AddCompanyPosMode1747012680000', () => {
  const buildRunner = (): { runner: QueryRunner; sql: () => string; calls: () => string[] } => {
    const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
    return {
      runner: { query } as unknown as QueryRunner,
      sql: () => query.mock.calls.map((call) => String(call[0])).join('\n'),
      calls: () => query.mock.calls.map((call) => String(call[0])),
    };
  };

  const migration = new AddCompanyPosMode1747012680000();

  it('crea el enum con exactamente los dos modos', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);

    expect(sql()).toMatch(
      /CREATE TYPE "companies_pos_mode_enum" AS ENUM \('retail', 'restaurant'\)/,
    );
  });

  it('el enum se crea de forma re-ejecutable (protegido por el catálogo)', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);

    expect(sql()).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'companies_pos_mode_enum'\)/,
    );
  });

  it("añade la columna NOT NULL con default 'retail' (nadie cambia de POS)", async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);

    expect(sql()).toMatch(
      /ADD COLUMN IF NOT EXISTS "pos_mode" "companies_pos_mode_enum" NOT NULL DEFAULT 'retail'/,
    );
  });

  it('crea el tipo ANTES de usarlo en la columna', async () => {
    const { runner, calls } = buildRunner();
    await migration.up(runner);

    const type_index = calls().findIndex((s) => s.includes('CREATE TYPE'));
    const column_index = calls().findIndex((s) => s.includes('ADD COLUMN'));
    expect(type_index).toBeGreaterThanOrEqual(0);
    expect(column_index).toBeGreaterThan(type_index);
  });

  it('no hace backfill ni toca filas existentes', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);

    expect(sql()).not.toMatch(/\bUPDATE\s+"?companies"?/i);
    expect(sql()).not.toMatch(/INSERT\s+INTO/i);
  });

  it('down elimina la columna y DESPUÉS el tipo', async () => {
    const { runner, calls } = buildRunner();
    await migration.down(runner);

    const column_index = calls().findIndex((s) => s.includes('DROP COLUMN IF EXISTS "pos_mode"'));
    const type_index = calls().findIndex((s) =>
      s.includes('DROP TYPE IF EXISTS "companies_pos_mode_enum"'),
    );
    expect(column_index).toBeGreaterThanOrEqual(0);
    expect(type_index).toBeGreaterThan(column_index);
  });
});
