import type { QueryRunner } from 'typeorm';

import { AddPurchasePaymentDueAt1747012940000 } from '../1747012940000-add-purchase-payment-due-at';

/**
 * El plazo de pago es nuevo: las compras existentes quedan SIN plazo (NULL),
 * sin backfill. La columna es timestamptz porque guarda el instante exacto
 * del vencimiento (final del día en Bogotá).
 */
describe('AddPurchasePaymentDueAt1747012940000', () => {
  const buildRunner = (): { runner: QueryRunner; sql: () => string; calls: () => string[] } => {
    const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
    return {
      runner: { query } as unknown as QueryRunner,
      sql: () => query.mock.calls.map((call) => String(call[0])).join('\n'),
      calls: () => query.mock.calls.map((call) => String(call[0])),
    };
  };

  const migration = new AddPurchasePaymentDueAt1747012940000();

  it('añade payment_due_at como TIMESTAMPTZ NULL, re-ejecutable', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    expect(sql()).toMatch(/ADD COLUMN IF NOT EXISTS "payment_due_at" TIMESTAMPTZ NULL/);
  });

  it('el plazo nunca puede vencer antes de la creación de la compra', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    expect(sql()).toMatch(/CHECK \("payment_due_at" IS NULL OR "payment_due_at" >= "created_at"\)/);
  });

  it('crea el índice parcial por company para "por vencer / vencidas"', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    expect(sql()).toMatch(
      /CREATE INDEX IF NOT EXISTS "idx_purchases_company_payment_due"\s+ON "purchases" \("company_id", "payment_due_at"\)\s+WHERE "payment_due_at" IS NOT NULL/,
    );
  });

  it('no hace backfill ni toca filas existentes', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    expect(sql()).not.toMatch(/UPDATE|INSERT|DELETE/);
  });

  it('crea la columna ANTES de la constraint y el índice', async () => {
    const { runner, calls } = buildRunner();
    await migration.up(runner);
    const column_index = calls().findIndex((s) => s.includes('ADD COLUMN'));
    const check_index = calls().findIndex((s) => s.includes('ADD CONSTRAINT'));
    const index_index = calls().findIndex((s) => s.includes('CREATE INDEX'));
    expect(column_index).toBe(0);
    expect(check_index).toBeGreaterThan(column_index);
    expect(index_index).toBeGreaterThan(column_index);
  });

  it('down revierte índice, constraint y columna', async () => {
    const { runner, sql } = buildRunner();
    await migration.down(runner);
    expect(sql()).toMatch(/DROP INDEX IF EXISTS "idx_purchases_company_payment_due"/);
    expect(sql()).toMatch(/DROP CONSTRAINT IF EXISTS "chk_purchases_payment_due_after_creation"/);
    expect(sql()).toMatch(/DROP COLUMN IF EXISTS "payment_due_at"/);
  });
});
