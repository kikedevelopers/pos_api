import type { QueryRunner } from 'typeorm';

import { AddCreditNoteIdToSalePayments1747012380000 } from '../1747012380000-add-credit-note-id-to-sale-payments';

/**
 * El cobro de una nota débito es dinero real que entra a la caja, así que tiene
 * que existir como pago de la venta: sin él la factura figura cobrada por su
 * total viejo y la Meta del mes —que va sobre lo COBRADO— se queda corta con
 * plata que ya está en el cajón.
 *
 * La columna es lo que permite distinguir ese cobro de uno normal para
 * mostrarlo como "corrección por nota débito".
 */
describe('AddCreditNoteIdToSalePayments1747012380000', () => {
  const buildRunner = (): { runner: QueryRunner; sql: () => string } => {
    const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
    return {
      runner: { query } as unknown as QueryRunner,
      sql: () => query.mock.calls.map((call) => String(call[0])).join('\n'),
    };
  };

  const migration = new AddCreditNoteIdToSalePayments1747012380000();

  it('añade la columna como NULLABLE', async () => {
    // Los pagos normales no la usan; obligarla rompería todo cobro existente.
    const { runner, sql } = buildRunner();
    await migration.up(runner);

    expect(sql()).toMatch(/ADD COLUMN IF NOT EXISTS "credit_note_id" bigint NULL/);
  });

  it('enlaza con la nota y sobrevive a su borrado', async () => {
    // ON DELETE SET NULL: si la nota desaparece, el pago sigue siendo un cobro
    // válido de la venta; perderlo sería perder dinero registrado.
    const { runner, sql } = buildRunner();
    await migration.up(runner);

    expect(sql()).toMatch(/FOREIGN KEY \("credit_note_id"\) REFERENCES "credit_notes"/);
    expect(sql()).toContain('ON DELETE SET NULL');
  });

  it('indexa solo los pagos que son corrección', async () => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);

    expect(sql()).toMatch(/CREATE INDEX[\s\S]*WHERE "credit_note_id" IS NOT NULL/);
  });

  it('no inventa cobros históricos', async () => {
    // Los 16 cobros que nunca se registraron NO se rellenan aquí: sería
    // fabricar movimientos de caja que nadie hizo.
    const { runner, sql } = buildRunner();
    await migration.up(runner);

    // Se busca la sentencia, no la palabra: "ON UPDATE CASCADE" de la FK no
    // cuenta como un backfill.
    expect(sql()).not.toMatch(/\bUPDATE\s+"?sale_payments"?/i);
    expect(sql()).not.toMatch(/INSERT\s+INTO\s+"?sale_payments"?/i);
  });

  it('se revierte sin tocar los pagos', async () => {
    const { runner, sql } = buildRunner();
    await migration.down(runner);

    expect(sql()).toContain('DROP COLUMN IF EXISTS "credit_note_id"');
    expect(sql()).not.toMatch(/DELETE|TRUNCATE|DROP TABLE/i);
  });
});
