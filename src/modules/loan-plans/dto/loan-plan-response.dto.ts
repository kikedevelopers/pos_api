import { ApiProperty } from '@nestjs/swagger';

import {
  LOAN_PLAN_TYPES,
  LOAN_RATE_PERIODS,
  type LoanPlanType,
  type LoanRatePeriod,
} from '../internal/loan-plan-rules';
import type { LoanPlan } from '../entities/loan-plan.entity';

export class LoanPlanResponseDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ enum: LOAN_PLAN_TYPES }) plan_type!: LoanPlanType;
  @ApiProperty({ example: 6 }) interest_rate!: number;
  @ApiProperty({ enum: LOAN_RATE_PERIODS }) rate_period!: LoanRatePeriod;
  @ApiProperty({ nullable: true, type: Number }) installments_count!: number | null;
  @ApiProperty({ nullable: true, type: Number }) collection_days!: number | null;
  @ApiProperty() is_archived!: boolean;
  @ApiProperty() created_at!: string;
  @ApiProperty() updated_at!: string;
}

/** `numeric` llega como string desde Postgres: se entrega como número. */
export function toLoanPlanResponseDto(plan: LoanPlan): LoanPlanResponseDto {
  return {
    id: Number(plan.id),
    name: plan.name,
    description: plan.description ?? null,
    plan_type: plan.plan_type,
    interest_rate: Number(plan.interest_rate),
    rate_period: plan.rate_period,
    installments_count: plan.installments_count ?? null,
    collection_days: plan.collection_days ?? null,
    is_archived: plan.is_archived,
    created_at: new Date(plan.created_at).toISOString(),
    updated_at: new Date(plan.updated_at).toISOString(),
  };
}
