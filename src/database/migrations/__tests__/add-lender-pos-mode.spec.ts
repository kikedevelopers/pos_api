import type { QueryRunner } from 'typeorm';

import { AddLenderPosMode1747012950000 } from '../1747012950000-add-lender-pos-mode';

/**
 * Agregar el tipo de negocio "prestamistas" NO puede cambiarle el modo a
 * nadie: solo suma un valor al enum. Y el `down` no puede dejar filas con un
 * valor que el tipo reconstruido ya no admite.
 */
describe('AddLenderPosMode1747012950000', () => {
  const buildRunner = (): { runner: QueryRunner; calls: () => string[] } => {
    const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
    return {
      runner: { query } as unknown as QueryRunner,
      calls: () => query.mock.calls.map((call) => String(call[0])),
    };
  };

  const migration = new AddLenderPosMode1747012950000();

  it('up: agrega lender al enum de forma re-ejecutable', async () => {
    const { runner, calls } = buildRunner();
    await migration.up(runner);

    expect(calls().join('\n')).toMatch(
      /ALTER TYPE "companies_pos_mode_enum" ADD VALUE IF NOT EXISTS 'lender'/,
    );
  });

  it('up: no toca filas (ni UPDATE ni cambio de default)', async () => {
    const { runner, calls } = buildRunner();
    await migration.up(runner);

    const sql = calls().join('\n');
    expect(sql).not.toMatch(/UPDATE/i);
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });

  it('down: devuelve los prestamistas a retail ANTES de reconstruir el tipo', async () => {
    const { runner, calls } = buildRunner();
    await migration.down(runner);

    const all = calls();
    const update = all.findIndex((s) => /SET "pos_mode" = 'retail' WHERE "pos_mode" = 'lender'/.test(s));
    const create = all.findIndex((s) => /CREATE TYPE "companies_pos_mode_enum" AS ENUM \('retail', 'restaurant'\)/.test(s));
    expect(update).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(update);
  });

  it('down: convierte la columna al tipo nuevo, restaura el default y borra el viejo', async () => {
    const { runner, calls } = buildRunner();
    await migration.down(runner);

    const all = calls();
    const convert = all.findIndex((s) => /USING "pos_mode"::text::"companies_pos_mode_enum"/.test(s));
    const restoreDefault = all.findIndex((s) => /SET DEFAULT 'retail'/.test(s));
    const dropOld = all.findIndex((s) => /DROP TYPE "companies_pos_mode_enum_old"/.test(s));
    expect(convert).toBeGreaterThan(0);
    expect(restoreDefault).toBeGreaterThan(convert);
    expect(dropOld).toBeGreaterThan(restoreDefault);
  });
});
