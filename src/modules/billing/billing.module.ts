import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Subscription } from '@/modules/subscriptions/entities/subscription.entity';
import { SubscriptionsModule } from '@/modules/subscriptions/subscriptions.module';

import { ApplyWompiTransactionAction } from './actions/apply-wompi-transaction.action';
import { ConfirmPaymentAction } from './actions/confirm-payment.action';
import { CreateCheckoutAction } from './actions/create-checkout.action';
import { HandleWompiEventAction } from './actions/handle-wompi-event.action';
import { ListPaymentsAction } from './actions/list-payments.action';
import { BillingAlertsService } from './billing-alerts.service';
import { PortalPaymentsController, WompiWebhookController } from './billing.controller';
import { BillingScheduler } from './billing.scheduler';
import { SubscriptionPayment } from './entities/subscription-payment.entity';
import { WompiClient } from './wompi/wompi.client';

/**
 * Módulo `billing` (cloud-only): cobro de la suscripción con links de pago de
 * Wompi. El punto de entrada del dinero es `ApplyWompiTransactionAction`; todo
 * lo demás (checkout, webhook, regreso, barrido) termina ahí.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SubscriptionPayment, Subscription]), SubscriptionsModule],
  controllers: [PortalPaymentsController, WompiWebhookController],
  providers: [
    WompiClient,
    BillingAlertsService,
    ApplyWompiTransactionAction,
    CreateCheckoutAction,
    ConfirmPaymentAction,
    ListPaymentsAction,
    HandleWompiEventAction,
    BillingScheduler,
  ],
})
export class BillingModule {}
