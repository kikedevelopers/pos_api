import type { DataSource } from 'typeorm';

import { GetDashboardSalesAction } from '../actions/get-dashboard-sales.action';

/**
 * Auditoría de exclusión — Préstamo a Tercero (LOAN).
 *
 * El informe de ventas del dashboard lee `sale_invoices` directamente y mapea
 * CADA fila a un ticket. Sin un filtro base, un LOAN (que tiene `sold_at` y
 * `created_at` como cualquier factura) se colaría en la lista. Verificamos que
 * la query base lo excluye por tipo.
 */
describe('GetDashboardSalesAction · exclusión de préstamos (LOAN)', () => {
  let action: GetDashboardSalesAction;
  let querySpy: jest.Mock;

  beforeEach(() => {
    querySpy = jest.fn(() => Promise.resolve([]));
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    action = new GetDashboardSalesAction(dataSourceMock);
  });

  it('la query de facturas excluye ticket_type LOAN', async () => {
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' });
    // La 1.ª query es la de facturas; debe traer el filtro de exclusión.
    const invoiceSql = String(querySpy.mock.calls[0][0]);
    expect(invoiceSql).toContain("si.ticket_type::text <> 'LOAN'");
    // Multi-tenant intacto.
    expect(invoiceSql).toContain('si.company_id = $1');
  });
});
