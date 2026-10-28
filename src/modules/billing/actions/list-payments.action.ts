import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';

import { toPaymentResponseDto, type PaymentResponseDto } from '../dto/payment-response.dto';
import { SubscriptionPayment } from '../entities/subscription-payment.entity';

/** Últimos pagos del titular (historial del portal). */
export const PAYMENTS_HISTORY_LIMIT = 100;

@Injectable()
export class ListPaymentsAction {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    @InjectRepository(SubscriptionPayment)
    private readonly paymentsRepo: Repository<SubscriptionPayment>,
  ) {}

  async execute(userId: number, companyId: number): Promise<PaymentResponseDto[]> {
    const subscription = await this.subscriptionsService.findApplicable(companyId);
    if (!subscription) {
      throw new NotFoundException('Suscripción no encontrada');
    }
    if (subscription.owner_user_id !== String(userId)) {
      throw new ForbiddenException({
        message: 'Solo el titular de la cuenta puede ver sus pagos.',
        payload: { code: 'PORTAL_OWNER_ONLY' },
      });
    }
    const payments = await this.paymentsRepo.find({
      where: { subscription_id: subscription.id },
      order: { created_at: 'DESC' },
      take: PAYMENTS_HISTORY_LIMIT,
    });
    return payments.map(toPaymentResponseDto);
  }
}
