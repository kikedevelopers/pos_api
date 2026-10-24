import type { QueryRunner } from 'typeorm';

import { CreateLoanPlans1747012960000 } from '../1747012960000-create-loan-plans';

describe('CreateLoanPlans1747012960000', () => {
  const run = async (dir: 'up' | 'down'): Promise<string> => {
    const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
    await new CreateLoanPlans1747012960000()[dir]({ query } as unknown as QueryRunner);
    return query.mock.calls.map((c) => String(c[0])).join('\n');
  };

  it('crea los enums antes de la tabla, de forma re-ejecutable', async () => {
    const sql = await run('up');
    expect(sql.indexOf('loan_plans_plan_type_enum')).toBeLessThan(sql.indexOf('CREATE TABLE'));
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'loan_plans_plan_type_enum'\)/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "loan_plans"/);
  });

  it('los CHECK exigen IS NOT NULL (un NULL no pasa por coherente)', async () => {
    const sql = await run('up');
    expect(sql).toMatch(/installments_count IS NOT NULL\s+AND installments_count BETWEEN 1 AND 360/);
    expect(sql).toMatch(/collection_days IS NOT NULL\s+AND collection_days BETWEEN 1 AND 31/);
  });

  it('multi-tenant: FK con CASCADE, índice y UNIQUE parcial por nombre', async () => {
    const sql = await run('up');
    expect(sql).toMatch(/REFERENCES "companies" \("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"idx_loan_plans_company_name_unique"[\s\S]*lower\(btrim\(name\)\)\)[\s\S]*WHERE is_archived = false/);
  });

  it('down borra la tabla antes que sus tipos', async () => {
    const sql = await run('down');
    expect(sql.indexOf('DROP TABLE')).toBeLessThan(sql.indexOf('DROP TYPE'));
  });
});
