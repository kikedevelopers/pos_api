import type { QueryRunner } from 'typeorm';

import { AddLoanDisbursementConcepts1747012970000 } from '../1747012970000-add-loan-disbursement-concepts';
import { CreateLoans1747012980000 } from '../1747012980000-create-loans';

const sqlOf = async (run: (q: QueryRunner) => Promise<void>): Promise<string> => {
  const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
  await run({ query } as unknown as QueryRunner);
  return query.mock.calls.map((c) => String(c[0])).join('\n');
};

describe('AddLoanDisbursementConcepts1747012970000', () => {
  const migration = new AddLoanDisbursementConcepts1747012970000();

  it('corre fuera de transacción y agrega el valor a ambos enums', async () => {
    expect(migration.transaction).toBe(false);
    const sql = await sqlOf((q) => migration.up(q));
    expect(sql).toMatch(/ALTER TYPE "movement_concept" ADD VALUE IF NOT EXISTS 'LOAN_DISBURSEMENT'/);
    expect(sql).toMatch(/ALTER TYPE "cash_register_log_type" ADD VALUE IF NOT EXISTS 'LOAN_DISBURSEMENT'/);
  });
});

describe('CreateLoans1747012980000', () => {
  const migration = new CreateLoans1747012980000();

  it('reglas de dinero en CHECK: capital > 0 y saldo dentro del capital', async () => {
    const sql = await sqlOf((q) => migration.up(q));
    expect(sql).toMatch(/CHECK \(principal > 0\)/);
    expect(sql).toMatch(/outstanding_principal >= 0 AND outstanding_principal <= principal/);
    expect(sql).toMatch(/source_type IN \('cash_register', 'bank', 'wallet'\)/);
  });

  it('FKs: company CASCADE, cliente RESTRICT, plan SET NULL (el préstamo guarda su copia)', async () => {
    const sql = await sqlOf((q) => migration.up(q));
    expect(sql).toMatch(/REFERENCES "companies" \("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/REFERENCES "customers" \("id"\) ON DELETE RESTRICT/);
    expect(sql).toMatch(/REFERENCES "loan_plans" \("id"\) ON DELETE SET NULL/);
  });

  it('down borra la tabla antes del tipo', async () => {
    const sql = await sqlOf((q) => migration.down(q));
    expect(sql.indexOf('DROP TABLE')).toBeLessThan(sql.indexOf('DROP TYPE'));
  });
});
