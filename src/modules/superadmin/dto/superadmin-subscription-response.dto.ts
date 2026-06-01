import { ApiProperty } from '@nestjs/swagger';

import type { Subscription } from '@/modules/subscriptions/entities/subscription.entity';

/**
 * Resultado de `PATCH /superadmin/tenants/:companyId/subscription`: la
 * suscripción resultante tras fijar/extender el vencimiento.
 */
export class SuperadminSubscriptionResponseDto {
  @ApiProperty({ example: 12 })
  id!: number;

  @ApiProperty({ example: 8 })
  companyId!: number;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  startedAt!: string;

  @ApiProperty({ example: '2026-12-31T23:59:59.000Z' })
  expiresAt!: string;

  @ApiProperty({ example: true, description: 'expiresAt > now al momento de responder.' })
  active!: boolean;
}

export function toSuperadminSubscriptionResponseDto(
  sub: Subscription,
): SuperadminSubscriptionResponseDto {
  return {
    id: Number(sub.id),
    companyId: Number(sub.company_id),
    startedAt: sub.started_at.toISOString(),
    expiresAt: sub.expires_at.toISOString(),
    active: sub.expires_at.getTime() > Date.now(),
  };
}
