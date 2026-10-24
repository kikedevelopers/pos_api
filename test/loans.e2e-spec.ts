import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { ListFinancialMovementsAction } from '@/modules/financial-movements/actions/list-financial-movements.action';
import { RecordFinancialMovementAction } from '@/modules/financial-movements/actions/record-financial-movement.action';
import { FinancialMovement } from '@/modules/financial-movements/entities/financial-movement.entity';
import { CreateLoanAction } from '@/modules/loans/actions/create-loan.action';
import { FindAllLoansAction } from '@/modules/loans/actions/find-all-loans.action';
import { toLoanResponseDto } from '@/modules/loans/dto/loan-response.dto';
import { Loan } from '@/modules/loans/entities/loan.entity';
import { businessToday } from '@/modules/loans/internal/loan-start-date';

import { cleanupCompany, createDisposableCompany, tryInitDataSource } from './helpers/e2e-db';

/**
 * E2E con BD REAL (pos_db): registrar un préstamo mueve dinero. Verifica que
 * el desembolso baja el saldo de la cuenta origen y deja su rastro (log de caja
 * o movimiento financiero LOAN_DISBURSEMENT), que el préstamo guarda COPIA de
 * las condiciones del plan, y que cualquier error deja todo como estaba
 * (atomicidad). Sin BD, se SKIPea.
 */

const COMPANY_A = '__E2E_LOANS_A__';
const COMPANY_B = '__E2E_LOANS_B__';
const BANK_START = 5_000_000;
const CASH_START = 300_000;

describe('Loans (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  let cid = 0;
  let otherCid = 0;
  let actor = { id: 0, fullName: 'E2E Prestamista' };
  let customerId = 0;
  let archivedCustomerId = 0;
  let otherCustomerId = 0;
  let fixedPlanId = 0;
  let dailyPlanId = 0;
  let archivedPlanId = 0;
  let bankId = 0;
  let create: CreateLoanAction;
  let findAll: FindAllLoansAction;

  const q = async <T = { id: string }>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await ds!.query(sql, params)) as T[];
  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await q(sql, params))[0].id);

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — loans e2e SKIPPED.');
      return;
    }
    cid = await createDisposableCompany(ds, COMPANY_A);
    otherCid = await createDisposableCompany(ds, COMPANY_B);
    actor = {
      id: await one(
        `INSERT INTO users (name, lastname, email, password, type, company_id)
         VALUES ('E2E', 'Prestamista', $1, 'x', 'owner', $2) RETURNING id`,
        [`__e2e_loans_${Date.now()}@example.test`, String(cid)],
      ),
      fullName: 'E2E Prestamista',
    };
    await q(`INSERT INTO cash_registers (company_id, user_id, balance) VALUES ($1, $2, $3)`, [
      String(cid),
      String(actor.id),
      CASH_START,
    ]);
    bankId = await one(
      `INSERT INTO banks (company_id, name, account_number, balance) VALUES ($1, 'NEQUI', '3117', $2) RETURNING id`,
      [String(cid), BANK_START],
    );
    customerId = await one(`INSERT INTO customers (company_id, name) VALUES ($1, 'ALONSO REYES') RETURNING id`, [
      String(cid),
    ]);
    archivedCustomerId = await one(
      `INSERT INTO customers (company_id, name, is_archived) VALUES ($1, 'ARCHIVADO', true) RETURNING id`,
      [String(cid)],
    );
    otherCustomerId = await one(`INSERT INTO customers (company_id, name) VALUES ($1, 'AJENO') RETURNING id`, [
      String(otherCid),
    ]);
    fixedPlanId = await one(
      `INSERT INTO loan_plans (company_id, name, plan_type, interest_rate, rate_period, installments_count)
       VALUES ($1, 'Mensual 6%', 'fixed_installment', 6, 'monthly', 12) RETURNING id`,
      [String(cid)],
    );
    dailyPlanId = await one(
      `INSERT INTO loan_plans (company_id, name, plan_type, interest_rate, rate_period, installments_count, collection_days)
       VALUES ($1, 'Diario', 'daily_installment', 6, 'monthly', 12, 26) RETURNING id`,
      [String(cid)],
    );
    archivedPlanId = await one(
      `INSERT INTO loan_plans (company_id, name, plan_type, interest_rate, rate_period, is_archived)
       VALUES ($1, 'Viejo', 'interest_only', 5, 'monthly', true) RETURNING id`,
      [String(cid)],
    );

    const financial = new FinancialMovementsService(
      new ListFinancialMovementsAction(ds.getRepository(FinancialMovement)),
      new RecordFinancialMovementAction(),
    );
    create = new CreateLoanAction(ds, financial);
    findAll = new FindAllLoansAction(ds.getRepository(Loan));
  });

  afterAll(async () => {
    if (!ds) return;
    for (const company of [cid, otherCid]) {
      for (const table of [
        'loans',
        'loan_plans',
        'financial_movements',
        'cash_register_logs',
        'cash_registers',
        'banks',
        'customers',
      ]) {
        await q(`DELETE FROM ${table} WHERE company_id = $1`, [String(company)]);
      }
      await cleanupCompany(ds, company);
    }
    await ds.destroy();
  });

  const balanceOf = async (table: 'banks' | 'cash_registers', where: string, id: number) =>
    Number((await q<{ balance: string }>(`SELECT balance FROM ${table} WHERE ${where} = $1`, [String(id)]))[0].balance);

  it('desde un banco: baja el saldo, registra LOAN_DISBURSEMENT y copia el plan', async () => {
    if (!ds) return;
    const loan = await create.execute(
      { customer_id: customerId, loan_plan_id: fixedPlanId, principal: 10000, source_type: 'bank', source_id: bankId },
      cid,
      actor,
    );
    const dto = toLoanResponseDto(loan);
    expect(dto).toMatchObject({
      customer_name: 'ALONSO REYES',
      plan_name: 'Mensual 6%',
      plan_type: 'fixed_installment',
      interest_rate: 6,
      installments_count: 12,
      principal: 10000,
      outstanding_principal: 10000,
      installment_amount: 1192.77,
      daily_amount: null,
      status: 'active',
      source_type: 'bank',
      source_name: 'NEQUI - 3117',
      start_date: businessToday(),
    });
    expect(await balanceOf('banks', 'id', bankId)).toBe(BANK_START - 10000);

    const [movement] = await q<{ concept: string; movement_type: string; amount: string; reference_code: string }>(
      `SELECT concept, movement_type, amount, reference_code FROM financial_movements WHERE company_id = $1`,
      [String(cid)],
    );
    expect(movement).toMatchObject({ concept: 'LOAN_DISBURSEMENT', movement_type: 'EXPENSE', reference_code: loan.reference_code });
    expect(Number(movement.amount)).toBe(10000);
  });

  it('desde la caja: baja la caja del actor y deja log LOAN_DISBURSEMENT OUT', async () => {
    if (!ds) return;
    const loan = await create.execute(
      { customer_id: customerId, loan_plan_id: dailyPlanId, principal: 10000, source_type: 'cash_register', start_date: '2026-09-01' },
      cid,
      actor,
    );
    expect(toLoanResponseDto(loan)).toMatchObject({ daily_amount: 45.88, start_date: '2026-09-01', source_name: 'Caja' });
    expect(await balanceOf('cash_registers', 'user_id', actor.id)).toBe(CASH_START - 10000);
    const logs = await q<{ type: string; direction: string }>(
      `SELECT type, direction FROM cash_register_logs WHERE company_id = $1`,
      [String(cid)],
    );
    expect(logs).toEqual([{ type: 'LOAN_DISBURSEMENT', direction: 'OUT' }]);
  });

  it('saldo insuficiente: 422 y NADA cambia (ni saldo ni préstamo)', async () => {
    if (!ds) return;
    const bankBefore = await balanceOf('banks', 'id', bankId);
    const loansBefore = (await findAll.execute(cid)).length;
    await expect(
      create.execute(
        { customer_id: customerId, loan_plan_id: fixedPlanId, principal: 99_000_000, source_type: 'bank', source_id: bankId },
        cid,
        actor,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await balanceOf('banks', 'id', bankId)).toBe(bankBefore);
    expect((await findAll.execute(cid)).length).toBe(loansBefore);
  });

  it.each([
    ['cliente archivado', () => ({ customer_id: archivedCustomerId, loan_plan_id: fixedPlanId })],
    ['cliente de otra company', () => ({ customer_id: otherCustomerId, loan_plan_id: fixedPlanId })],
    ['plan archivado', () => ({ customer_id: customerId, loan_plan_id: archivedPlanId })],
  ])('%s: 404 sin mover dinero', async (_label, ids) => {
    if (!ds) return;
    const bankBefore = await balanceOf('banks', 'id', bankId);
    await expect(
      create.execute({ ...ids(), principal: 1000, source_type: 'bank', source_id: bankId }, cid, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await balanceOf('banks', 'id', bankId)).toBe(bankBefore);
  });

  it('fecha futura o inexistente: 400', async () => {
    if (!ds) return;
    for (const start_date of ['2999-01-01', '2026-02-30']) {
      await expect(
        create.execute(
          { customer_id: customerId, loan_plan_id: fixedPlanId, principal: 1000, source_type: 'bank', source_id: bankId, start_date },
          cid,
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('editar el plan después NO cambia el préstamo ya hecho', async () => {
    if (!ds) return;
    await q(`UPDATE loan_plans SET interest_rate = 9, installments_count = 3 WHERE id = $1`, [String(fixedPlanId)]);
    const [loan] = (await findAll.execute(cid, { status: 'active' })).filter((l) => l.loan_plan_id === String(fixedPlanId));
    expect(toLoanResponseDto(loan)).toMatchObject({ interest_rate: 6, installments_count: 12, installment_amount: 1192.77 });
  });

  it('la cartera filtra por cliente y no mezcla companies', async () => {
    if (!ds) return;
    expect((await findAll.execute(cid, { customerId })).length).toBe(2);
    expect(await findAll.execute(otherCid)).toEqual([]);
  });
});
