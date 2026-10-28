import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import type { SubscriptionPayment } from '../entities/subscription-payment.entity';

export class CreateCheckoutDto {
  @ApiProperty({ enum: ['monthly', 'annual'] })
  @IsIn(['monthly', 'annual'])
  plan!: 'monthly' | 'annual';
}

export class ConfirmPaymentDto {
  @ApiPropertyOptional({
    description: 'Id de la transacción que Wompi añade a la URL de regreso (`?id=`).',
    example: '1132-903100443-27458',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9-]+$/)
  transaction_id?: string;
}

/** Lo que el portal sabe de un pago. Nunca expone ids internos de Wompi más allá del de la transacción. */
export class PaymentResponseDto {
  @ApiProperty({ example: '6f1c…' })
  reference!: string;

  @ApiProperty({ enum: ['monthly', 'annual'] })
  plan!: string;

  @ApiProperty({ example: 40000000 })
  amount_in_cents!: number;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ example: 365 })
  days_granted!: number;

  @ApiProperty({
    enum: ['pending', 'approved', 'declined', 'voided', 'error', 'expired', 'needs_review'],
  })
  status!: string;

  @ApiProperty({ description: 'URL del checkout de Wompi.' })
  checkout_url!: string;

  @ApiProperty()
  link_expires_at!: string;

  @ApiPropertyOptional({ nullable: true })
  transaction_id!: string | null;

  @ApiPropertyOptional({ nullable: true })
  payment_method_type!: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Motivo legible si no pasó.' })
  failure_reason!: string | null;

  @ApiPropertyOptional({ nullable: true })
  applied_at!: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Desde cuándo corren los días pagados.' })
  period_starts_at!: string | null;

  @ApiPropertyOptional({ nullable: true })
  period_ends_at!: string | null;

  @ApiProperty()
  created_at!: string;
}

export function toPaymentResponseDto(payment: SubscriptionPayment): PaymentResponseDto {
  return {
    reference: payment.reference,
    plan: payment.plan,
    amount_in_cents: Number(payment.amount_in_cents),
    currency: payment.currency,
    days_granted: payment.days_granted,
    status: payment.status,
    checkout_url: payment.checkout_url,
    link_expires_at: payment.link_expires_at.toISOString(),
    transaction_id: payment.provider_transaction_id ?? null,
    payment_method_type: payment.payment_method_type ?? null,
    failure_reason: payment.failure_reason ?? null,
    applied_at: payment.applied_at?.toISOString() ?? null,
    period_starts_at: payment.period_starts_at?.toISOString() ?? null,
    period_ends_at: payment.period_ends_at?.toISOString() ?? null,
    created_at: payment.created_at.toISOString(),
  };
}
