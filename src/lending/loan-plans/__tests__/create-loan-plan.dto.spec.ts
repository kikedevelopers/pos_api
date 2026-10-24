import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateLoanPlanDto } from '../dto/create-loan-plan.dto';
import { ListLoanPlansQueryDto } from '../dto/list-loan-plans-query.dto';
import { SetLoanPlanArchivedDto } from '../dto/set-loan-plan-archived.dto';

const errorsOf = async (cls: new () => object, body: object) =>
  (await validate(plainToInstance(cls, body))).map((e) => e.property);

describe('CreateLoanPlanDto', () => {
  const valid = { name: 'Mensual', plan_type: 'interest_only', interest_rate: 6, rate_period: 'monthly' };

  it('acepta un plan válido, con cuotas/días null', async () => {
    expect(await errorsOf(CreateLoanPlanDto, valid)).toEqual([]);
    expect(
      await errorsOf(CreateLoanPlanDto, { ...valid, installments_count: null, collection_days: null }),
    ).toEqual([]);
  });

  it.each([
    [{ plan_type: 'gota' }, 'plan_type'],
    [{ rate_period: 'daily' }, 'rate_period'],
    [{ interest_rate: '6' }, 'interest_rate'],
    [{ interest_rate: 1.23456 }, 'interest_rate'],
    [{ installments_count: 2.5 }, 'installments_count'],
    [{ collection_days: 'veinte' }, 'collection_days'],
    [{ name: 'x'.repeat(101) }, 'name'],
  ])('rechaza %p', async (over, property) => {
    expect(await errorsOf(CreateLoanPlanDto, { ...valid, ...over })).toContain(property);
  });
});

describe('ListLoanPlansQueryDto / SetLoanPlanArchivedDto', () => {
  it('include_archived solo es true con "true"', () => {
    expect(plainToInstance(ListLoanPlansQueryDto, { include_archived: 'true' }).include_archived).toBe(true);
    expect(plainToInstance(ListLoanPlansQueryDto, { include_archived: '1' }).include_archived).toBe(false);
  });

  it('is_archived debe ser booleano', async () => {
    expect(await errorsOf(SetLoanPlanArchivedDto, { is_archived: true })).toEqual([]);
    expect(await errorsOf(SetLoanPlanArchivedDto, { is_archived: 'si' })).toContain('is_archived');
  });
});
