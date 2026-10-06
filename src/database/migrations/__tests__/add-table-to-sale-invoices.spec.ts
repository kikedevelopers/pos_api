import type { QueryRunner } from 'typeorm';

import { AddTableToSaleInvoices1747012720000 } from '../1747012720000-add-table-to-sale-invoices';

/**
 * La mesa/salón del pedido son opcionales (retail no los usa) y sus FKs no
 * deben borrar ventas al borrar una mesa/salón (ON DELETE SET NULL, conservando
 * el snapshot de nombre).
 */
describe('AddTableToSaleInvoices1747012720000', () => {
  const buildRunner = (): { runner: QueryRunner; sql: () => string } => {
    const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
    return {
      runner: { query } as unknown as QueryRunner,
      sql: () => query.mock.calls.map((c) => String(c[0])).join('\n'),
    };
  };
  const migration = new AddTableToSaleInvoices1747012720000();

  it('añade table_id/salon_id/table_name/salon_name como NULLABLE (retail intacto)', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    expect(sql()).toMatch(/ADD COLUMN IF NOT EXISTS "table_id" bigint NULL/);
    expect(sql()).toMatch(/ADD COLUMN IF NOT EXISTS "salon_id" bigint NULL/);
    expect(sql()).toMatch(/ADD COLUMN IF NOT EXISTS "table_name" text NULL/);
    expect(sql()).toMatch(/ADD COLUMN IF NOT EXISTS "salon_name" text NULL/);
  });

  it('FK de mesa con ON DELETE SET NULL (borrar mesa no borra la venta)', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    expect(sql()).toMatch(
      /fk_sale_invoices_table_id[\s\S]*REFERENCES "restaurant_tables"[\s\S]*ON DELETE SET NULL/,
    );
    expect(sql()).toMatch(
      /fk_sale_invoices_salon_id[\s\S]*REFERENCES "salons"[\s\S]*ON DELETE SET NULL/,
    );
  });

  it('las FK se crean de forma re-ejecutable (guard por pg_constraint)', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    expect(sql()).toMatch(/WHERE conname = 'fk_sale_invoices_table_id'/);
  });

  it('indexa solo los pedidos con mesa (índice parcial)', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    expect(sql()).toMatch(/idx_sale_invoices_table_id[\s\S]*WHERE table_id IS NOT NULL/);
  });

  it('no hace backfill', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    expect(sql()).not.toMatch(/\bUPDATE\s+\S+\s+SET\b/i);
    expect(sql()).not.toMatch(/INSERT\s+INTO/i);
  });

  it('down elimina FKs y columnas', async () => {
    const { runner, sql } = buildRunner();
    await migration.down(runner);
    expect(sql()).toMatch(/DROP CONSTRAINT IF EXISTS "fk_sale_invoices_table_id"/);
    expect(sql()).toMatch(/DROP COLUMN IF EXISTS "table_id"/);
  });
});
