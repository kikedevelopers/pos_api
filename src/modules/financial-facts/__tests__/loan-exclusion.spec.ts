import type { DataSource } from 'typeorm';

import { fetchCollectedProfit, fetchAbonoCollectedProfit } from '../internal/collection-facts';
import { fetchNoteTotals, fetchRealizedProfitBase } from '../internal/sales-facts';

/**
 * Auditoría de exclusión — Préstamo a Tercero (LOAN) en los facts financieros.
 *
 * Un LOAN tiene `sold_at`/`created_at` como cualquier factura, así que la
 * ganancia DEVENGADA (`sales-facts`) NO debe contarlo: se blinda por
 * `ticket_type = 'SALE'`. La ganancia COBRADA (`collection-facts`) lo excluye
 * DOBLE: INNER JOIN a `sale_payments` (un LOAN nunca crea pagos) + el mismo
 * filtro `ticket_type = 'SALE'`.
 *
 * Estos asserts fijan el CONTRATO: un cambio futuro que meta ORDER u otros
 * tipos en la agregación (o que quite el filtro / el INNER JOIN) rompe el test.
 */
describe('financial-facts · exclusión de préstamos (LOAN)', () => {
  let querySpy: jest.Mock;
  let dataSource: DataSource;

  const dateStart = new Date('2026-05-01T00:00:00Z');
  const dateEnd = new Date('2026-05-31T23:59:59Z');

  beforeEach(() => {
    querySpy = jest.fn(() => Promise.resolve([]));
    dataSource = { query: querySpy } as unknown as DataSource;
  });

  const lastSql = (): string => String(querySpy.mock.calls[querySpy.mock.calls.length - 1][0]);

  describe('base devengada (sales-facts)', () => {
    it('fetchRealizedProfitBase agrega SOLO ticket_type = SALE', async () => {
      await fetchRealizedProfitBase(dataSource, 42, dateStart, dateEnd);
      const sql = lastSql();
      expect(sql).toContain("si.ticket_type = 'SALE'");
      // Nunca debe abrirse a otros tipos: ni ORDER ni LOAN.
      expect(sql).not.toContain("ticket_type IN");
      expect(sql).not.toMatch(/ticket_type\s*=\s*'LOAN'/);
    });

    it('fetchNoteTotals solo netea notas de ventas SALE', async () => {
      await fetchNoteTotals(dataSource, 42, dateStart, dateEnd);
      expect(lastSql()).toContain("si.ticket_type = 'SALE'");
    });
  });

  describe('base caja / cobrada (collection-facts)', () => {
    it('fetchCollectedProfit exige INNER JOIN a sale_payments + ticket_type SALE', async () => {
      await fetchCollectedProfit(dataSource, 42, dateStart, dateEnd);
      const sql = lastSql();
      // Un LOAN no tiene pagos → el INNER JOIN ya lo deja fuera...
      expect(sql).toContain('INNER JOIN sale_invoices si');
      expect(sql).toContain('FROM sale_payments sp');
      // ...y además filtra explícitamente por venta.
      expect(sql).toContain("si.ticket_type = 'SALE'");
    });

    it('fetchAbonoCollectedProfit conserva el mismo blindaje', async () => {
      await fetchAbonoCollectedProfit(dataSource, 42, dateStart, dateEnd);
      const sql = lastSql();
      expect(sql).toContain('FROM sale_payments sp');
      expect(sql).toContain("si.ticket_type = 'SALE'");
    });
  });
});
