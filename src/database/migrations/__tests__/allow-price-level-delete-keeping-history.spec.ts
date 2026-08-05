import type { QueryRunner } from 'typeorm';

import { AllowPriceLevelDeleteKeepingHistory1747012300000 } from '../1747012300000-allow-price-level-delete-keeping-history';

/**
 * La migración es la que realmente arregla el bug ("no se puede eliminar un
 * nivel de precio que ya tiene ventas"), así que su SQL se verifica aquí: sin
 * `ON DELETE SET NULL` en las dos FKs el borrado vuelve a fallar, y sin el
 * `DROP NOT NULL` el SET NULL de `product_price_history` reventaría.
 */
describe('AllowPriceLevelDeleteKeepingHistory1747012300000', () => {
  const buildRunner = (
    queryImpl?: jest.Mock,
  ): { runner: QueryRunner; query: jest.Mock; sql: () => string } => {
    const query = queryImpl ?? jest.fn(() => Promise.resolve([]));
    return {
      runner: { query } as unknown as QueryRunner,
      query,
      sql: () => query.mock.calls.map((call) => String(call[0])).join('\n'),
    };
  };

  const migration = new AllowPriceLevelDeleteKeepingHistory1747012300000();

  describe('up', () => {
    it('relaja el NOT NULL de product_price_history.product_price_id', async () => {
      const { runner, sql } = buildRunner();
      await migration.up(runner);

      expect(sql()).toContain(
        'ALTER TABLE public.product_price_history ALTER COLUMN product_price_id DROP NOT NULL',
      );
    });

    it('recrea la FK de product_price_history con ON DELETE SET NULL', async () => {
      const { runner, query } = buildRunner();
      await migration.up(runner);

      const addFk = query.mock.calls
        .map((call) => String(call[0]))
        .find((s) => s.includes('ADD CONSTRAINT fk_pph_product_price_id'));

      expect(addFk).toBeDefined();
      expect(addFk).toContain('ON DELETE SET NULL');
      expect(addFk).not.toContain('NO ACTION');
    });

    it('recrea la FK de sale_invoice_lines con ON DELETE SET NULL', async () => {
      const { runner, query } = buildRunner();
      await migration.up(runner);

      const addFk = query.mock.calls
        .map((call) => String(call[0]))
        .find((s) => s.includes('ADD CONSTRAINT fk_sale_invoice_lines_product_price_id'));

      expect(addFk).toBeDefined();
      expect(addFk).toContain('ON DELETE SET NULL');
      expect(addFk).not.toContain('NO ACTION');
    });

    it('dropea cada FK con IF EXISTS (re-ejecutable sobre esquemas parciales)', async () => {
      const { runner, query } = buildRunner();
      await migration.up(runner);

      const drops = query.mock.calls
        .map((call) => String(call[0]))
        .filter((s) => s.includes('DROP CONSTRAINT'));

      expect(drops).toHaveLength(2);
      drops.forEach((s) => expect(s).toContain('IF EXISTS'));
    });

    it('dropea la FK ANTES de volver a crearla', async () => {
      const { runner, query } = buildRunner();
      await migration.up(runner);

      const statements = query.mock.calls.map((call) => String(call[0]));
      const dropIdx = statements.findIndex((s) => s.includes('DROP CONSTRAINT IF EXISTS fk_pph'));
      const addIdx = statements.findIndex((s) => s.includes('ADD CONSTRAINT fk_pph'));

      expect(dropIdx).toBeGreaterThanOrEqual(0);
      expect(addIdx).toBeGreaterThan(dropIdx);
    });
  });

  describe('down', () => {
    it('restaura NO ACTION y el NOT NULL cuando no hay huérfanos', async () => {
      const query = jest.fn((sql: string) =>
        sql.includes('COUNT(*)') ? Promise.resolve([{ orphans: 0 }]) : Promise.resolve([]),
      );
      const { runner, sql } = buildRunner(query as unknown as jest.Mock);

      await migration.down(runner);

      expect(sql()).toContain('ON DELETE NO ACTION');
      expect(sql()).toContain('ALTER COLUMN product_price_id SET NOT NULL');
    });

    it('aborta sin destruir histórico si quedaron snapshots huérfanos', async () => {
      const query = jest.fn((sql: string) =>
        sql.includes('COUNT(*)') ? Promise.resolve([{ orphans: 3 }]) : Promise.resolve([]),
      );
      const { runner, sql } = buildRunner(query as unknown as jest.Mock);

      await expect(migration.down(runner)).rejects.toThrow(/3 filas/);
      expect(sql()).not.toContain('SET NOT NULL');
    });
  });
});
