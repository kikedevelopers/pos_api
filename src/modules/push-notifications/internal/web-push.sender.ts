import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';

import type { PushConfig } from '@/config/push.config';

/** Destino de un envío (lo que guarda `push_subscriptions`). */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Envoltura de `web-push`: firma con las llaves VAPID y cifra para el
 * navegador. Aislada para poder simularla en los tests.
 */
@Injectable()
export class WebPushSender {
  constructor(private readonly configService: ConfigService) {}

  private get config(): PushConfig {
    return this.configService.getOrThrow<PushConfig>('push');
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get publicKey(): string {
    return this.config.publicKey;
  }

  async send(target: PushTarget, payload: string): Promise<void> {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      payload,
      {
        TTL: 60 * 60,
        urgency: 'high',
        vapidDetails: {
          subject: this.config.subject,
          publicKey: this.config.publicKey,
          privateKey: this.config.privateKey,
        },
      },
    );
  }
}
