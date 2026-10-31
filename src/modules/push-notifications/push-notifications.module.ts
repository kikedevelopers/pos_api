import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RolesModule } from '@/modules/roles/roles.module';

import { PushSubscriptionEntity } from './entities/push-subscription.entity';
import { WebPushSender } from './internal/web-push.sender';
import { PushNotificationsController } from './push-notifications.controller';
import { PushNotificationsService } from './push-notifications.service';

/**
 * Módulo `push-notifications` — avisos push de la PWA (Web Push / VAPID).
 * Exporta el servicio para que los módulos que generan avisos (pedidos del
 * agente) los envíen.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PushSubscriptionEntity]), RolesModule],
  controllers: [PushNotificationsController],
  providers: [PushNotificationsService, WebPushSender],
  exports: [PushNotificationsService],
})
export class PushNotificationsModule {}
