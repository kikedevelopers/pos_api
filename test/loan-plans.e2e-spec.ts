import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';

import { CreateLoanPlanAction } from '@/modules/loan-plans/actions/create-loan-plan.action';
import { FindAllLoanPlansAction } from '@/modules/loan-plans/actions/find-all-loan-plans.action';
import { FindLoanPlanAction } from '@/modules/loan-plans/actions/find-loan-plan.action';
import { SetLoanPlanArchivedAction } from '@/modules/loan-plans/actions/set-loan-plan-archived.action';
import { UpdateLoanPlanAction } from '@/modules/loan-plans/actions/update-loan-plan.action';
import { toLoanPlanResponseDto } from '@/modules/loan-plans/dto/loan-plan-response.dto';
import { LoanPlan } from '@/modules/loan-plans/entities/loan-plan.entity';

import { cleanupCompany, createDisposableCompany, E2E_ACTOR, tryInitDataSource } from './helpers/e2e-db';

/**
 * E2E con BD REAL (pos_db): planes de préstamo. Verifica el CRUD contra la
 * tabla real, que los CHECK de la base respaldan las reglas por tipo (aunque
 * alguien salte la action), el UNIQUE parcial de nombre y el aislamiento
 * multi-tenant. Sin BD, se SKIPea.
 */

const COMPANY_A = '__E2E_LOAN_PLANS_A__';
const COMPANY_B = '__E2E_LOAN_PLANS_B__';

describe('Loan plans (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  let companyA = 0;
  let companyB = 0;
  let repo: Repository<LoanPlan>;
  let create: CreateLoanPlanAction;
  let update: UpdateLoanPlanAction;
  let findAll: FindAllLoanPlansAction;
  let findOne: FindLoanPlanAction;
  let setArchived: SetLoanPlanArchivedAction;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — loan-plans e2e SKIPPED.');
      return;
    }
    companyA = await createDisposableCompany(ds, COMPANY_A);
    companyB = await createDisposableCompany(ds, COMPANY_B);
    repo = ds.getRepository(LoanPlan);
    findOne = new FindLoanPlanAction(repo);
    create = new CreateLoanPlanAction(repo);
    update = new UpdateLoanPlanAction(repo, findOne);
    findAll = new FindAllLoanPlansAction(repo);
    setArchived = new SetLoanPlanArchivedAction(repo, findOne);
  });

  afterAll(async () => {
    if (!ds) return;
    for (const cid of [companyA, companyB]) {
      await ds.query(`DELETE FROM loan_plans WHERE company_id = $1`, [String(cid)]);
      await cleanupCompany(ds, cid);
    }
    await ds.destroy();
  });

  it('crea los tres tipos y los devuelve con la tasa como número', async () => {
    if (!ds) return;
    const interest = await create.execute(
      { name: 'Interés 6%', plan_type: 'interest_only', interest_rate: 6, rate_period: 'monthly' },
      companyA,
      E2E_ACTOR,
    );
    const fixed = await create.execute(
      {
        name: 'Cuota fija 12',
        plan_type: 'fixed_installment',
        interest_rate: 2.5125,
        rate_period: 'monthly',
        installments_count: 12,
      },
      companyA,
      E2E_ACTOR,
    );
    const daily = await create.execute(
      {
        name: 'Diario',
        plan_type: 'daily_installment',
        interest_rate: 20,
        rate_period: 'monthly',
        installments_count: 1,
        collection_days: 26,
      },
      companyA,
      E2E_ACTOR,
    );

    expect(toLoanPlanResponseDto(await findOne.execute(Number(fixed.id), companyA))).toMatchObject({
      name: 'Cuota fija 12',
      plan_type: 'fixed_installment',
      interest_rate: 2.5125,
      installments_count: 12,
      collection_days: null,
      is_archived: false,
    });
    expect(Number(interest.id)).toBeGreaterThan(0);
    expect(daily.collection_days).toBe(26);
    expect(daily.created_by).toBe(E2E_ACTOR.fullName);
  });

  it('nombre repetido entre activos (sin importar mayúsculas/espacios): 409', async () => {
    if (!ds) return;
    await expect(
      create.execute(
        { name: '  interés 6%  ', plan_type: 'interest_only', interest_rate: 5, rate_period: 'weekly' },
        companyA,
        E2E_ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('otra company puede usar el mismo nombre y no ve los planes ajenos', async () => {
    if (!ds) return;
    await create.execute(
      { name: 'Interés 6%', plan_type: 'interest_only', interest_rate: 6, rate_period: 'monthly' },
      companyB,
      E2E_ACTOR,
    );
    const fromB = await findAll.execute(companyB);
    expect(fromB.map((p) => p.name)).toEqual(['Interés 6%']);

    const [planOfA] = await findAll.execute(companyA);
    await expect(findOne.execute(Number(planOfA.id), companyB)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('editar: cambiar a interés fijo limpia cuotas y días', async () => {
    if (!ds) return;
    const plan = (await findAll.execute(companyA)).find((p) => p.name === 'Diario')!;
    const updated = await update.execute(Number(plan.id), { plan_type: 'interest_only' }, companyA);
    expect(updated.installments_count).toBeNull();
    expect(updated.collection_days).toBeNull();
  });

  it('editar: pasar a cuota diaria sin días de cobro es 400', async () => {
    if (!ds) return;
    const plan = (await findAll.execute(companyA)).find((p) => p.name === 'Cuota fija 12')!;
    await expect(
      update.execute(Number(plan.id), { plan_type: 'daily_installment' }, companyA),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('archivar libera el nombre; restaurar con el nombre ocupado es 409', async () => {
    if (!ds) return;
    const original = (await findAll.execute(companyA)).find((p) => p.name === 'Interés 6%')!;
    await setArchived.execute(Number(original.id), true, companyA);

    expect((await findAll.execute(companyA)).some((p) => p.id === original.id)).toBe(false);
    expect((await findAll.execute(companyA, true)).some((p) => p.id === original.id)).toBe(true);

    await create.execute(
      { name: 'Interés 6%', plan_type: 'interest_only', interest_rate: 7, rate_period: 'monthly' },
      companyA,
      E2E_ACTOR,
    );
    await expect(setArchived.execute(Number(original.id), false, companyA)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('la base rechaza un plan incoherente aunque se salte la action (CHECK)', async () => {
    if (!ds) return;
    const insert = (plan_type: string, installments: number | null, days: number | null, rate = 5) =>
      ds!.query(
        `INSERT INTO loan_plans (company_id, name, plan_type, interest_rate, rate_period, installments_count, collection_days)
         VALUES ($1, $2, $3, $4, 'monthly', $5, $6)`,
        [String(companyA), `raw-${Math.random()}`, plan_type, rate, installments, days],
      );
    await expect(insert('daily_installment', 2, null)).rejects.toThrow(/chk_loan_plans_collection_days/);
    await expect(insert('fixed_installment', null, null)).rejects.toThrow(/chk_loan_plans_installments/);
    await expect(insert('interest_only', 3, null)).rejects.toThrow(/chk_loan_plans_installments/);
    await expect(insert('interest_only', null, null, 101)).rejects.toThrow(/chk_loan_plans_rate_range/);
  });
});
