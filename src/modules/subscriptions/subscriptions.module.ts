import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CreateSubscriptionAction } from './actions/create-subscription.action';
import { Subscription } from './entities/subscription.entity';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Módulo `subscriptions` (cloud-only). Suscripción POR EMPRESA con trial de
 * gracia. Cuando vence, la company queda bloqueada (login + rutas protegidas).
 *
 * Sin dependencias hacia AuthModule (evita ciclo): es `AuthModule` quien
 * importa ESTE módulo para sembrar la suscripción en el registro y bloquear el
 * login. `app.module.ts` también lo importa para resolver `SubscriptionGuard`
 * (APP_GUARD) y `SubscriptionsService`.
 *
 * Exporta:
 *   - `SubscriptionsService`    → consumido por el guard global y `LoginAction`.
 *   - `CreateSubscriptionAction` → consumido por `RegisterAction`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Subscription])],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, CreateSubscriptionAction],
  exports: [SubscriptionsService, CreateSubscriptionAction],
})
export class SubscriptionsModule {}
