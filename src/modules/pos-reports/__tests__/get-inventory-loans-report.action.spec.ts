import type { DataSource } from 'typeorm';

import { GetInventoryLoansReportAction } from '../actions/get-inventory-loans-report.action';

/**
 * Informe "Préstamo de Inventario" (ticket_type = 'LOAN').
 *
 * Verifica que la query SOLO trae préstamos, respeta multi-tenancy y filtros, y
 * que el summary (cantidad, valor, ganancia, margen) se calcula sobre los
 * préstamos ACTIVOS (los anulados no cuentan como mercancía prestada viva).
 */
describe('GetInventoryLoansReportAction', () => {
  let action: GetInventoryLoansReportAction;
  let querySpy: jest.Mock;

  const buildAction = (rows: unknown[]) => {
    querySpy = jest.fn(() => Promise.resolve(rows));
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    return new GetInventoryLoansReportAction(dataSourceMock);
  };

  it('exige dateFrom y dateTo', async () => {
    action = buildAction([]);
    await expect(action.execute(42, {})).rejects.toThrow('dateFrom y dateTo son requeridos');
  });

  it('la query filtra SOLO préstamos (LOAN), por company y por defecto excluye anulados', async () => {
    action = buildAction([]);
    await action.execute(42, { dateFrom: '2026-09-01', dateTo: '2026-09-30' });
    const sql = String(querySpy.mock.calls[0][0]);
    expect(sql).toContain("si.ticket_type = 'LOAN'");
    expect(sql).toContain('si.company_id = $1');
    expect(sql).toContain('si.is_deleted = false');
  });

  it('con showDeleted NO agrega el filtro is_deleted=false', async () => {
    action = buildAction([]);
    await action.execute(42, { dateFrom: '2026-09-01', dateTo: '2026-09-30', showDeleted: true });
    const sql = String(querySpy.mock.calls[0][0]);
    expect(sql).not.toContain('si.is_deleted = false');
  });

  it('agrega la búsqueda por cliente/número de ticket cuando llega search', async () => {
    action = buildAction([]);
    await action.execute(42, { dateFrom: '2026-09-01', dateTo: '2026-09-30', search: 'PED-8270' });
    const sql = String(querySpy.mock.calls[0][0]);
    expect(sql).toContain('si.customer_name ILIKE');
    expect(sql).toContain('si.ticket_number ILIKE');
    const params = querySpy.mock.calls[0][1] as unknown[];
    expect(params).toContain('%PED-8270%');
  });

  it('mapea filas y calcula ganancia/margen por préstamo', async () => {
    action = buildAction([
      {
        id: '300',
        ticket_number: 'PED-8270',
        customer_name: 'MAURI ESPITIA',
        created_by: 'Enrique Pacheco',
        total: 13800,
        cost: 10500,
        is_deleted: false,
        realized_at: new Date('2026-09-24T13:33:00.000Z'),
      },
    ]);
    const result = await action.execute(42, { dateFrom: '2026-09-01', dateTo: '2026-09-30' });
    expect(result.loans).toHaveLength(1);
    const loan = result.loans[0];
    expect(loan.ticketNumber).toBe('PED-8270');
    expect(loan.customerName).toBe('MAURI ESPITIA');
    expect(loan.total).toBe(13800);
    expect(loan.profit).toBe(3300);
    expect(loan.margin).toBeCloseTo(23.91, 1);
  });

  it('el summary cuenta y suma SOLO los préstamos activos (ignora anulados)', async () => {
    action = buildAction([
      {
        id: '1',
        ticket_number: 'PED-1',
        customer_name: 'A',
        created_by: 'X',
        total: 10000,
        cost: 6000,
        is_deleted: false,
        realized_at: new Date('2026-09-10T10:00:00.000Z'),
      },
      {
        id: '2',
        ticket_number: 'PED-2',
        customer_name: 'B',
        created_by: 'X',
        total: 5000,
        cost: 4000,
        is_deleted: true, // anulado (mercancía devuelta) → NO cuenta
        realized_at: new Date('2026-09-11T10:00:00.000Z'),
      },
    ]);
    const result = await action.execute(42, {
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
      showDeleted: true,
    });
    expect(result.summary.total_loans_count).toBe(1);
    expect(result.summary.total_voided_count).toBe(1);
    expect(result.summary.total_value).toBe(10000);
    expect(result.summary.total_cost).toBe(6000);
    expect(result.summary.total_profit).toBe(4000);
    expect(result.summary.average_margin).toBe(40);
  });
});
