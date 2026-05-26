import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Excepción de suscripción vencida (o inexistente) para una company.
 *
 * Status: **402 Payment Required** — semánticamente preciso (la cuenta debe
 * "pagar/renovar" para continuar) y distinguible de 401 (token) / 403 (rol).
 *
 * Body (vía `AllExceptionsFilter`, mismo shape `{ message, payload: { code } }`
 * que `EMAIL_TAKEN`):
 *
 *   {
 *     "success": false,
 *     "error": "Tu suscripción ha vencido. Renueva para continuar.",
 *     "payload": { "code": "SUBSCRIPTION_EXPIRED", "details": { "expires_at": "..." } }
 *   }
 *
 * `expires_at` se inyecta como ISO string en `payload.details` para que el
 * cliente pueda mostrar la fecha de vencimiento. Cuando la company NO tiene
 * suscripción, `expires_at` es `null`.
 */
export class SubscriptionExpiredException extends HttpException {
  constructor(expiresAt: Date | null) {
    super(
      {
        message: 'Tu suscripción ha vencido. Renueva para continuar.',
        payload: {
          code: 'SUBSCRIPTION_EXPIRED',
          details: { expires_at: expiresAt ? expiresAt.toISOString() : null },
        },
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
