import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { Subscription, SubscriptionPlan } from '../entities/subscription.entity';
import {
  resolveEffectiveStatus,
  type EffectiveSubscriptionStatus,
} from '../internal/subscription-state';

/**
 * Estado de la suscripción de la company actual. El endpoint `GET /subscription`
 * está exento del `SubscriptionGuard` (`@SkipSubscriptionCheck()`), así que este
 * DTO se sirve también con `is_expired = true` cuando venció — el cliente lo usa
 * para pintar el estado "vencida".
 */
export class SubscriptionResponseDto {
  @ApiProperty({ example: '2026-05-26T10:00:00.000Z' })
  started_at!: string;

  @ApiProperty({ example: '2026-06-05T10:00:00.000Z' })
  expires_at!: string;

  @ApiProperty({
    example: 10,
    description: 'Días totales de la ventana (started_at → expires_at).',
  })
  days_total!: number;

  @ApiProperty({
    example: 3,
    description: 'Días consumidos (days_total - days_remaining, nunca negativo).',
  })
  days_used!: number;

  @ApiProperty({
    example: 7,
    description: 'Días enteros restantes hasta el vencimiento (0 si ya venció).',
  })
  days_remaining!: number;

  @ApiProperty({
    example: 0.3,
    description: 'Fracción consumida 0..1 (days_used / days_total). Para barras de progreso.',
  })
  progress!: number;

  @ApiProperty({ example: false })
  is_expired!: boolean;

  /**
   * Campos de plan/cobro. Se AÑADEN al contrato existente (nunca se quitan ni
   * se renombran los de arriba): el cliente PlacePos instalado sigue leyendo
   * los suyos sin enterarse de estos.
   */
  @ApiProperty({ example: 'free', enum: ['free', 'monthly', 'annual'] })
  plan!: SubscriptionPlan;

  @ApiProperty({
    example: 'trialing',
    enum: ['trialing', 'active', 'payment_pending', 'payment_failed', 'canceled', 'expired'],
    description: 'Estado de cobro ya cruzado con la vigencia. `expired` es derivado.',
  })
  status!: EffectiveSubscriptionStatus;

  @ApiPropertyOptional({
    example: 'annual',
    nullable: true,
    description: 'Plan solicitado y pendiente de pago. `null` si no hay nada pendiente.',
  })
  requested_plan!: SubscriptionPlan | null;

  @ApiPropertyOptional({ example: '2026-08-15T10:00:00.000Z', nullable: true })
  plan_requested_at!: string | null;
}

/**
 * Serializa una `Subscription` al shape de respuesta. `days_remaining` se
 * calcula contra `now` redondeando hacia arriba (un día parcial cuenta como
 * día restante); nunca es negativo. `days_total`/`days_used`/`progress` se
 * derivan para que el cliente (placepos cloud) pinte el mismo medidor que en
 * modo offline sin recomputar la ventana. `days_used + days_remaining =
 * days_total`.
 */
export function toSubscriptionResponseDto(
  subscription: Subscription,
  now: Date = new Date(),
): SubscriptionResponseDto {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const remainingMs = subscription.expires_at.getTime() - now.getTime();
  const isExpired = remainingMs <= 0;
  const daysRemaining = isExpired ? 0 : Math.ceil(remainingMs / MS_PER_DAY);

  const totalMs = subscription.expires_at.getTime() - subscription.started_at.getTime();
  const daysTotal = Math.max(0, Math.round(totalMs / MS_PER_DAY));
  const daysUsed = Math.max(0, daysTotal - daysRemaining);
  const progress =
    daysTotal > 0 ? Math.min(1, Math.max(0, daysUsed / daysTotal)) : isExpired ? 1 : 0;

  return {
    started_at: subscription.started_at.toISOString(),
    expires_at: subscription.expires_at.toISOString(),
    days_total: daysTotal,
    days_used: daysUsed,
    days_remaining: daysRemaining,
    progress,
    is_expired: isExpired,
    plan: subscription.plan,
    status: resolveEffectiveStatus({
      status: subscription.status,
      expires_at: subscription.expires_at,
      now,
    }),
    requested_plan: subscription.requested_plan ?? null,
    plan_requested_at: subscription.plan_requested_at?.toISOString() ?? null,
  };
}
