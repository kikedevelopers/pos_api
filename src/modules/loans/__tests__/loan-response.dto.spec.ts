import { toLoanResponseDto } from '../dto/loan-response.dto';
import type { Loan } from '../entities/loan.entity';

describe('toLoanResponseDto', () => {
  it('numeric → número, fecha recortada, nombre del cliente', () => {
    const loan = {
      id: '7',
      customer_id: '12',
      customer: { name: 'ALONSO REYES' },
      loan_plan_id: null,
      plan_name: 'Diario',
      plan_type: 'daily_installment',
      interest_rate: '6.0000',
      rate_period: 'monthly',
      installments_count: 12,
      collection_days: 26,
      principal: '10000.00',
      outstanding_principal: '10000.00',
      installment_amount: '1192.77',
      daily_amount: '45.88',
      start_date: '2026-10-24',
      status: 'active',
      source_type: 'cash_register',
      source_name: 'Caja',
      notes: null,
      created_at: new Date('2026-10-24T15:00:00Z'),
    } as unknown as Loan;
    expect(toLoanResponseDto(loan)).toEqual({
      id: 7,
      customer_id: 12,
      customer_name: 'ALONSO REYES',
      loan_plan_id: null,
      plan_name: 'Diario',
      plan_type: 'daily_installment',
      interest_rate: 6,
      rate_period: 'monthly',
      installments_count: 12,
      collection_days: 26,
      principal: 10000,
      outstanding_principal: 10000,
      installment_amount: 1192.77,
      daily_amount: 45.88,
      start_date: '2026-10-24',
      status: 'active',
      source_type: 'cash_register',
      source_name: 'Caja',
      notes: null,
      created_at: '2026-10-24T15:00:00.000Z',
    });
  });
});
