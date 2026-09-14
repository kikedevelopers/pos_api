import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

import { SubscriptionPlan } from '@/modules/subscriptions/entities/subscription.entity';

/**
 * Payload de `POST /portal/subscription/plan`.
 *
 * `free` es una petición legítima: es como el dueño cancela una solicitud de
 * pago o deja de renovar. Por eso el enum entero es válido y no solo los planes
 * de pago.
 */
export class ChangePlanDto {
  @ApiProperty({ enum: SubscriptionPlan, example: SubscriptionPlan.ANNUAL })
  @IsEnum(SubscriptionPlan, { message: 'plan debe ser free, monthly o annual' })
  plan!: SubscriptionPlan;
}
