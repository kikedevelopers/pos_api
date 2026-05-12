import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { ListAllPaymentsAction } from '../actions/list-all-payments.action';

/**
 * Tests unitarios del agregador `ListAllPaymentsAction`.
 *
 * Mismo enfoque que `ListAllCreditsAction.spec`: garantizamos que cada rama
 * del UNION incluye `company_id = $1` y que los filtros opcionales se
 * propagan correctamente. Aislamiento multi-tenant es la invariante crítica.
 */
describe('ListAllPaymentsAction', () => {
  let action: ListAllPaymentsAction;
  let querySpy: jest.Mock;

  beforeEach(async () => {
    querySpy = jest.fn((sql: string): Promise<unknown[]> => {
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve([{ count: 0 }]);
      }
      return Promise.resolve([]);
    });

    const dataSourceMock = { query: querySpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ListAllPaymentsAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(ListAllPaymentsAction);
  });

  function calls(): Array<{ sql: string; params: unknown[] }> {
    return querySpy.mock.calls.map(([sql, params]: [string, unknown[]]) => ({ sql, params }));
  }

  it('sin type: ambas ramas (sale + purchase) filtran company_id = $1', async () => {
    await action.execute(42, {});
    const dataCall = calls().find((c) => !c.sql.includes('COUNT(*)'));
    expect(dataCall?.sql).toMatch(/FROM sale_payments sp/);
    expect(dataCall?.sql).toMatch(/FROM purchase_payments pp/);
    expect(dataCall?.sql).toMatch(/UNION ALL/);
    expect(dataCall?.sql).toMatch(/sp\.company_id = \$1/);
    expect(dataCall?.sql).toMatch(/pp\.company_id = \$1/);
    expect(dataCall?.params[0]).toBe('42');
  });

  it('type=sale: solo la rama de sales, sin UNION', async () => {
    await action.execute(42, { type: 'sale' });
    const dataCall = calls().find((c) => !c.sql.includes('COUNT(*)'));
    expect(dataCall?.sql).toMatch(/FROM sale_payments sp/);
    expect(dataCall?.sql).not.toMatch(/FROM purchase_payments/);
    expect(dataCall?.sql).not.toMatch(/UNION ALL/);
  });

  it('type=purchase: solo la rama de purchases, sin UNION', async () => {
    await action.execute(42, { type: 'purchase' });
    const dataCall = calls().find((c) => !c.sql.includes('COUNT(*)'));
    expect(dataCall?.sql).toMatch(/FROM purchase_payments pp/);
    expect(dataCall?.sql).not.toMatch(/FROM sale_payments/);
  });

  it('customer_id solo aplica a sales; supplier_id solo a purchases', async () => {
    await action.execute(42, { customer_id: 5, supplier_id: 9 });
    const dataCall = calls().find((c) => !c.sql.includes('COUNT(*)'));
    expect(dataCall?.sql).toMatch(/si\.customer_id = \$\d+/);
    expect(dataCall?.sql).not.toMatch(/pp\.customer_id/);
    expect(dataCall?.sql).toMatch(/p\.supplier_id = \$\d+/);
    expect(dataCall?.sql).not.toMatch(/sp\.supplier_id/);
  });

  it('aislamiento cross-tenant: NO leak — solo $1 filtra company', async () => {
    await action.execute(42, { date_from: '2026-05-01', date_to: '2026-05-31' });

    const allCalls = calls();
    for (const call of allCalls) {
      expect(call.params[0]).toBe('42');
      const companyMatches = call.sql.match(/company_id\s*=\s*\$\d+/g) ?? [];
      for (const m of companyMatches) {
        expect(m).toMatch(/company_id\s*=\s*\$1/);
      }
    }
  });

  it('paginación: limit y offset se inyectan en el SQL', async () => {
    await action.execute(42, { limit: 25, offset: 100 });
    const dataCall = calls().find((c) => !c.sql.includes('COUNT(*)'));
    expect(dataCall?.sql).toMatch(/LIMIT 25/);
    expect(dataCall?.sql).toMatch(/OFFSET 100/);
  });

  it('shape uniforme: ambas ramas tienen las mismas columnas (homogeneizadas con NULL::text)', async () => {
    await action.execute(42, {});
    const dataCall = calls().find((c) => !c.sql.includes('COUNT(*)'));
    // sale_payments NO tiene `notes` → debe seleccionar NULL::text AS notes.
    expect(dataCall?.sql).toMatch(/NULL::text AS notes/);
    // purchase_payments NO tiene `change_amount` → debe seleccionar NULL::text AS change_amount.
    expect(dataCall?.sql).toMatch(/NULL::text AS change_amount/);
  });
});
