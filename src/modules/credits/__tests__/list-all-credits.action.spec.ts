import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { ListAllCreditsAction } from '../actions/list-all-credits.action';

/**
 * Tests unitarios del agregador `ListAllCreditsAction`.
 *
 * El foco es la **garantía de aislamiento multi-tenant**: cada query SQL
 * debe contener `company_id = $1` en CADA rama del UNION. Si se omitiera en
 * una rama, sería leak cross-tenant — bug de prioridad CRÍTICA.
 *
 * Por simplicidad, mockeamos `DataSource.query` y verificamos:
 *
 *   1. El SQL siempre incluye `company_id = $1` en ambas ramas (sale +
 *      purchase) cuando type no se especifica.
 *   2. El primer parámetro siempre es el companyId.
 *   3. Los filtros opcionales (status, customer_id, supplier_id, fechas) se
 *      propagan a la rama correcta.
 *   4. Cuando `type=sale` solo se ejecuta la rama de sales (sin UNION).
 *   5. Cuando `type=purchase` solo la rama de purchases.
 *   6. NO leak: una query con companyId=42 nunca incluye filtros por otra
 *      company.
 */
describe('ListAllCreditsAction', () => {
  let action: ListAllCreditsAction;
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
      providers: [ListAllCreditsAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(ListAllCreditsAction);
  });

  function calls(): Array<{ sql: string; params: unknown[] }> {
    return querySpy.mock.calls.map(([sql, params]: [string, unknown[]]) => ({ sql, params }));
  }

  it('sin type: ambas ramas (sale + purchase) filtran company_id = $1', async () => {
    await action.execute(42, {});

    const dataCall = calls().find((c) => !c.sql.includes('COUNT(*)'));
    expect(dataCall).toBeDefined();
    // Ambas ramas presentes.
    expect(dataCall?.sql).toMatch(/FROM sale_credits sc/);
    expect(dataCall?.sql).toMatch(/FROM purchase_credits pc/);
    expect(dataCall?.sql).toMatch(/UNION ALL/);

    // Ambas ramas filtran por $1.
    expect(dataCall?.sql).toMatch(/sc\.company_id = \$1/);
    expect(dataCall?.sql).toMatch(/pc\.company_id = \$1/);

    // El primer parámetro es el companyId stringificado.
    expect(dataCall?.params[0]).toBe('42');
  });

  it('type=sale: solo la rama de sales, sin UNION', async () => {
    await action.execute(42, { type: 'sale' });
    const dataCall = calls().find((c) => !c.sql.includes('COUNT(*)'));
    expect(dataCall?.sql).toMatch(/FROM sale_credits sc/);
    expect(dataCall?.sql).not.toMatch(/FROM purchase_credits/);
    expect(dataCall?.sql).not.toMatch(/UNION ALL/);
    expect(dataCall?.params[0]).toBe('42');
  });

  it('type=purchase: solo la rama de purchases, sin UNION', async () => {
    await action.execute(42, { type: 'purchase' });
    const dataCall = calls().find((c) => !c.sql.includes('COUNT(*)'));
    expect(dataCall?.sql).toMatch(/FROM purchase_credits pc/);
    expect(dataCall?.sql).not.toMatch(/FROM sale_credits/);
    expect(dataCall?.sql).not.toMatch(/UNION ALL/);
  });

  it('filtros opcionales propagan al SQL con placeholders correctos', async () => {
    await action.execute(42, {
      status: 'PARTIALLY_PAID',
      customer_id: 5,
      supplier_id: 9,
      date_from: '2026-05-01',
      date_to: '2026-05-31',
    });

    const dataCall = calls().find((c) => !c.sql.includes('COUNT(*)'));
    // Status aplica a ambas ramas con el mismo placeholder reutilizado.
    expect(dataCall?.sql).toMatch(/sc\.status = \$\d+::credit_status/);
    expect(dataCall?.sql).toMatch(/pc\.status = \$\d+::credit_status/);
    // customer_id solo a sales.
    expect(dataCall?.sql).toMatch(/sc\.customer_id = \$\d+/);
    expect(dataCall?.sql).not.toMatch(/pc\.customer_id/);
    // supplier_id solo a purchases.
    expect(dataCall?.sql).toMatch(/pc\.supplier_id = \$\d+/);
    expect(dataCall?.sql).not.toMatch(/sc\.supplier_id/);
    // Fechas aplican a ambas.
    expect(dataCall?.sql).toMatch(/sc\.created_at >=/);
    expect(dataCall?.sql).toMatch(/pc\.created_at >=/);

    // Los parámetros van en orden: companyId, status, customer_id, supplier_id, date_from, date_to.
    expect(dataCall?.params[0]).toBe('42');
    expect(dataCall?.params).toContain('PARTIALLY_PAID');
    expect(dataCall?.params).toContain('5');
    expect(dataCall?.params).toContain('9');
  });

  it('aislamiento cross-tenant: NO leak — companyId=42 jamás emite filtro de otra company', async () => {
    await action.execute(42, {});

    const allCalls = calls();
    for (const call of allCalls) {
      // No hay valores hardcoded de companies cross-tenant.
      expect(call.params[0]).toBe('42');
      // No hay un filtro adicional de company hardcoded (pattern más
      // robusto: validamos que el único filtro de company es vía $1).
      const companyMatches = call.sql.match(/company_id\s*=\s*\$\d+/g) ?? [];
      for (const m of companyMatches) {
        // Aceptamos $1 (companyId) — cualquier otro placeholder sería sospechoso.
        expect(m).toMatch(/company_id\s*=\s*\$1/);
      }
    }
  });

  it('paginación: limit y offset se inyectan en el SQL', async () => {
    await action.execute(42, { limit: 10, offset: 20 });
    const dataCall = calls().find((c) => !c.sql.includes('COUNT(*)'));
    expect(dataCall?.sql).toMatch(/LIMIT 10/);
    expect(dataCall?.sql).toMatch(/OFFSET 20/);
  });

  it('count y data queries comparten params para shape consistente', async () => {
    await action.execute(42, { status: 'PAID' });
    const allCalls = calls();
    expect(allCalls.length).toBe(2);
    // El count usa los mismos params que la data (subquery).
    expect(allCalls[0]?.params).toEqual(allCalls[1]?.params);
  });
});
