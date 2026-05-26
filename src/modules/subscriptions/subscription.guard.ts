import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { SKIP_SUBSCRIPTION_CHECK_KEY } from './skip-subscription-check.decorator';
import { SubscriptionExpiredException } from './subscription-expired.exception';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Guard global de vigencia de suscripción.
 *
 * Se registra como APP_GUARD JUSTO DESPUÉS de `JwtAuthGuard` y ANTES de
 * `RolesGuard`: necesita `request.user` ya poblado por JwtAuthGuard, y debe
 * cortar antes de cualquier lógica de rol/handler.
 *
 * Reglas:
 *   - Ruta `@Public()` (handler o class) → pasa. El login/register se gobiernan
 *     aparte: `LoginAction` aplica su propio chequeo tras validar password.
 *   - Sin `request.user` (ruta protegida sin token) → pasa; `JwtAuthGuard` ya
 *     la habrá rechazado antes.
 *   - `company_id` null/undefined (superadmin) → pasa. NUNCA se bloquea.
 *   - Suscripción inexistente o `expires_at < now` → 402 SUBSCRIPTION_EXPIRED.
 *   - Suscripción vigente → pasa.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // Endpoints marcados `@SkipSubscriptionCheck()` (ej. GET /subscription):
    // legibles aun con la suscripción vencida para que el cliente pueda pintar
    // su propio estado. Siguen exigiendo JWT (no son @Public).
    const skipCheck = this.reflector.getAllAndOverride<boolean>(SKIP_SUBSCRIPTION_CHECK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipCheck) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    // Sin user → JwtAuthGuard ya gobierna las rutas protegidas. No bloqueamos.
    if (!user) {
      return true;
    }

    // Superadmin (company_id null/undefined) nunca se bloquea.
    if (user.company_id === null || user.company_id === undefined) {
      return true;
    }

    const subscription = await this.subscriptionsService.findByCompany(user.company_id);

    if (!subscription) {
      throw new SubscriptionExpiredException(null);
    }

    const now = Date.now();
    if (subscription.expires_at.getTime() < now) {
      throw new SubscriptionExpiredException(subscription.expires_at);
    }

    return true;
  }
}
