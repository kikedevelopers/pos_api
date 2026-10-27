import { ApiProperty } from '@nestjs/swagger';

import type { LoanPlanType, LoanRatePeriod } from '@/lending/domain/loan-plan-rules';

import type { Loan, LoanSourceType, LoanStatus } from '../entities/loan.entity';

export class LoanResponseDto {
  @ApiProperty() id!: number;
  @ApiProperty() customer_id!: number;
  @ApiProperty() customer_name!: string;
  @ApiProperty({ nullable: true, type: Number }) loan_plan_id!: number | null;
  @ApiProperty() plan_name!: string;
  @ApiProperty() plan_type!: LoanPlanType;
  @ApiProperty() interest_rate!: number;
  @ApiProperty() rate_period!: LoanRatePeriod;
  @ApiProperty({ nullable: true, type: Number }) installments_count!: number | null;
  @ApiProperty({ nullable: true, type: Number }) collection_days!: number | null;
  @ApiProperty() principal!: number;
  @ApiProperty() outstanding_principal!: number;
  @ApiProperty({ nullable: true, type: Number }) installment_amount!: number | null;
  @ApiProperty({ nullable: true, type: Number }) daily_amount!: number | null;
  @ApiProperty({ example: '2026-10-24' }) start_date!: string;
  @ApiProperty() status!: LoanStatus;
  @ApiProperty() source_type!: LoanSourceType;
  @ApiProperty() source_name!: string;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty() created_at!: string;
}

const num = (value: string | number | null): number | null => (value === null ? null : Number(value));

/**
 * `numeric` llega como string: se entrega como número. El nombre del cliente
 * viene del puerto de clientes (préstamos no hace join con tablas del POS).
 */
export function toLoanResponseDto(loan: Loan, customerName: string): LoanResponseDto {
  return {
    id: Number(loan.id),
    customer_id: Number(loan.customer_id),
    customer_name: customerName,
    loan_plan_id: loan.loan_plan_id === null ? null : Number(loan.loan_plan_id),
    plan_name: loan.plan_name,
    plan_type: loan.plan_type,
    interest_rate: Number(loan.interest_rate),
    rate_period: loan.rate_period,
    installments_count: loan.installments_count ?? null,
    collection_days: loan.collection_days ?? null,
    principal: Number(loan.principal),
    outstanding_principal: Number(loan.outstanding_principal),
    installment_amount: num(loan.installment_amount),
    daily_amount: num(loan.daily_amount),
    start_date: String(loan.start_date).slice(0, 10),
    status: loan.status,
    source_type: loan.source_type,
    source_name: loan.source_name,
    notes: loan.notes ?? null,
    created_at: new Date(loan.created_at).toISOString(),
  };
}
