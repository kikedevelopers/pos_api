import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { GetSalesReportAction } from '../actions/get-sales-report.action';

/**
 * Tests unitarios de `GetSalesReportAction`.
 *
 * Foco: multi-tenancy en TODAS las subqueries (invoice principal + notas +
 * predicates de filtros). Si una rama de `applyNoteFilter` omitiera el
 * `company_id = $1` en su EXISTS, sería leak cross-tenant.
 */
describe('GetSalesReportAction', () => {
  let action: GetSalesReportAction;
  let querySpy: jest.Mock;

  beforeEach(() => {
    querySpy = jest.fn(() => Promise.resolve([]));
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    action = new GetSalesReportAction(dataSourceMock);
  });

  function allCalls(): Array<{ sql: string; params: unknown[] }> {
    return querySpy.mock.calls.map(([sql, params]: [string, unknown[]]) => ({ sql, params }));
  }

  it('400 si faltan dateFrom o dateTo', async () => {
    await expect(action.execute(42, { dateFrom: '2026-05-01' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(action.execute(42, { dateTo: '2026-05-31' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('multi-tenant: cada query filtra company_id en sale_invoices, sale_credits y credit_notes', async () => {
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' });
    const calls = allCalls();
    expect(calls.length).toBe(2); // invoice query + notes query.
    for (const c of calls) {
      expect(c.sql).toMatch(/si\.company_id\s*=\s*\$1/);
      expect(c.params[0]).toBe('42');
    }
    // El query principal debe filtrar el LEFT JOIN sale_credits por company_id.
    const invoiceCall = calls[0];
    expect(invoiceCall.sql).toMatch(/sc\.company_id\s*=\s*\$1/);
    // Sub-selects de credit_notes también filtran por company_id.
    expect(invoiceCall.sql).toMatch(/cn2\.company_id\s*=\s*\$1/);
  });

  it('noteFilter=FULL_VOID añade EXISTS con cn.company_id = $1', async () => {
    await action.execute(42, {
      dateFrom: '2026-05-01',
      dateTo: '2026-05-31',
      noteFilter: 'FULL_VOID',
    });
    const invoiceCall = allCalls()[0];
    expect(invoiceCall.sql).toMatch(/cn\.company_id\s*=\s*\$1/);
    expect(invoiceCall.sql).toMatch(/cn\.operation_type = 'FULL_VOID'/);
  });

  it('aislamiento cross-tenant: jamás emite filtro de company con placeholder distinto a $1', async () => {
    await action.execute(42, {
      dateFrom: '2026-05-01',
      dateTo: '2026-05-31',
      noteFilter: 'WITH_ADJUSTMENTS',
    });
    for (const c of allCalls()) {
      const matches = c.sql.match(/company_id\s*=\s*\$\d+/g) ?? [];
      for (const m of matches) {
        expect(m).toMatch(/company_id\s*=\s*\$1/);
      }
    }
  });

  it('ticketTypes CSV se aplica como IN con placeholders', async () => {
    await action.execute(42, {
      dateFrom: '2026-05-01',
      dateTo: '2026-05-31',
      ticketTypes: ['SALE', 'ORDER'],
    });
    const invoiceCall = allCalls()[0];
    expect(invoiceCall.sql).toMatch(/si\.ticket_type::text IN \(\$\d+,\$\d+\)/);
    expect(invoiceCall.params).toContain('SALE');
    expect(invoiceCall.params).toContain('ORDER');
  });
});
