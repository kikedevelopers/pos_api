import type { DataSource } from 'typeorm';

import { GetCreditsReportAction } from '../actions/get-credits-report.action';

/**
 * Tests unitarios de `GetCreditsReportAction`.
 *
 * Foco crítico: AISLAMIENTO multi-tenant. Una company A nunca debe ver
 * créditos de company B. Cubrimos:
 *
 *   1. SQL incluye `sc.company_id = $1` Y `si.company_id = $1` (ambas tablas).
 *   2. El primer parámetro siempre es companyId stringificado.
 *   3. Filtros opcionales (dateFrom, dateTo, search, status) propagan a
 *      placeholders correctos sin alterar el filtro de tenant.
 *   4. status='ALL' NO añade filtro (paridad PlacePos).
 *   5. Summary se calcula con Big.js sobre los rows devueltos.
 */
describe('GetCreditsReportAction', () => {
  let action: GetCreditsReportAction;
  let querySpy: jest.Mock;

  beforeEach(() => {
    querySpy = jest.fn(() => Promise.resolve([]));
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    action = new GetCreditsReportAction(dataSourceMock);
  });

  function lastCall(): { sql: string; params: unknown[] } {
    const calls = querySpy.mock.calls;
    const [sql, params] = calls[calls.length - 1] as [string, unknown[]];
    return { sql, params };
  }

  it('multi-tenant: filtra company_id en sale_credits Y sale_invoices con $1', async () => {
    await action.execute(42, {});
    const { sql, params } = lastCall();
    expect(sql).toMatch(/sc\.company_id\s*=\s*\$1/);
    expect(sql).toMatch(/si\.company_id\s*=\s*\$1/);
    expect(params[0]).toBe('42');
  });

  it('aislamiento cross-tenant: companyId=42 jamás se mezcla con $\\d+ != 1 en company_id', async () => {
    await action.execute(42, { search: 'Juan', status: 'PENDING' });
    const { sql } = lastCall();
    const matches = sql.match(/company_id\s*=\s*\$\d+/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m).toMatch(/company_id\s*=\s*\$1/);
    }
  });

  it('filtro de fechas se propaga como placeholders nuevos', async () => {
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' });
    const { sql, params } = lastCall();
    expect(sql).toMatch(/si\.created_at >= \$\d+/);
    expect(sql).toMatch(/si\.created_at <= \$\d+/);
    // Tras MED-1 auditoría Fase 11, las fechas se pasan como Date (parseUtcRange)
    // en UTC: [00:00:00.000Z, 23:59:59.999Z]. Antes iban como string.
    expect(params).toContainEqual(new Date('2026-05-01T00:00:00.000Z'));
    expect(params).toContainEqual(new Date('2026-05-31T23:59:59.999Z'));
  });

  it("status='ALL' NO añade filtro de status", async () => {
    await action.execute(42, { status: 'ALL' });
    const { sql } = lastCall();
    expect(sql).not.toMatch(/sc\.status::text =/);
  });

  it('status=PENDING propaga el filtro al SQL', async () => {
    await action.execute(42, { status: 'PENDING' });
    const { sql, params } = lastCall();
    expect(sql).toMatch(/sc\.status::text = \$\d+/);
    expect(params).toContain('PENDING');
  });

  it('summary agrega con Big.js los rows devueltos', async () => {
    querySpy.mockResolvedValueOnce([
      {
        id: '1',
        ticket_number: 'T1',
        sale_number: 'V-001',
        customer_name: 'Cliente A',
        created_by: 'Owner',
        created_at: new Date('2026-05-12T10:00:00Z'),
        credit_id: '10',
        total_amount: 0.1,
        paid_amount: 0,
        balance: 0.1,
        status: 'PENDING',
        due_date: null,
      },
      {
        id: '2',
        ticket_number: 'T2',
        sale_number: 'V-002',
        customer_name: 'Cliente B',
        created_by: 'Owner',
        created_at: new Date('2026-05-13T10:00:00Z'),
        credit_id: '11',
        total_amount: 0.2,
        paid_amount: 0,
        balance: 0.2,
        status: 'PENDING',
        due_date: null,
      },
    ]);

    const result = await action.execute(42, {});
    // 0.1 + 0.2 con Big.js debe dar EXACTAMENTE 0.3 (no 0.30000000000000004).
    expect(result.summary.total_amount).toBe(0.3);
    expect(result.summary.total_balance).toBe(0.3);
    expect(result.summary.pending_count).toBe(2);
    expect(result.summary.total_credits_count).toBe(2);
  });
});
