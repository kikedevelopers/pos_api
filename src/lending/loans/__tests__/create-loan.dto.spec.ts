import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateLoanDto } from '../dto/create-loan.dto';
import { ListLoansQueryDto } from '../dto/list-loans-query.dto';

const errorsOf = async (cls: new () => object, body: object) =>
  (await validate(plainToInstance(cls, body))).map((e) => e.property);

const valid = { customer_id: 1, loan_plan_id: 2, principal: 1000000, source_type: 'cash_register' };

describe('CreateLoanDto', () => {
  it('caja: no exige cuenta; banco/billetera sí', async () => {
    expect(await errorsOf(CreateLoanDto, valid)).toEqual([]);
    expect(await errorsOf(CreateLoanDto, { ...valid, source_type: 'bank' })).toContain('source_id');
    expect(await errorsOf(CreateLoanDto, { ...valid, source_type: 'wallet', source_id: 3 })).toEqual([]);
  });

  it.each([
    [{ principal: 0 }, 'principal'],
    [{ principal: -5 }, 'principal'],
    [{ principal: 10.123 }, 'principal'],
    [{ principal: 1e13 }, 'principal'],
    [{ customer_id: 0 }, 'customer_id'],
    [{ loan_plan_id: 'x' }, 'loan_plan_id'],
    [{ source_type: 'tarjeta' }, 'source_type'],
    [{ start_date: '24/10/2026' }, 'start_date'],
    [{ notes: 'x'.repeat(501) }, 'notes'],
  ])('rechaza %p', async (over, property) => {
    expect(await errorsOf(CreateLoanDto, { ...valid, ...over })).toContain(property);
  });

  it('acepta fecha y nota', async () => {
    expect(await errorsOf(CreateLoanDto, { ...valid, start_date: '2026-10-01', notes: ' Paga viernes ' })).toEqual([]);
  });
});

describe('ListLoansQueryDto', () => {
  it('estado válido y cliente numérico', async () => {
    expect(await errorsOf(ListLoansQueryDto, { status: 'active', customer_id: '12' })).toEqual([]);
    expect(await errorsOf(ListLoansQueryDto, { status: 'vencido' })).toContain('status');
  });
});
