import { SetMetadata } from '@nestjs/common';

/**
 * Marca un handler/controller para que `SubscriptionGuard` NO lo bloquee aunque
 * la suscripción de la company esté vencida. Sigue exigiendo JWT (no es
 * `@Public`): el usuario debe estar autenticado.
 *
 * Caso de uso: `GET /subscription`. El cliente (placepos cloud) necesita poder
 * LEER su propio estado de suscripción incluso vencido, para pintar el medidor
 * de días/estado "vencida" (paridad con el modo offline). Todo lo demás sigue
 * bloqueado al vencer.
 */
export const SKIP_SUBSCRIPTION_CHECK_KEY = 'skipSubscriptionCheck';

export const SkipSubscriptionCheck = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_SUBSCRIPTION_CHECK_KEY, true);
