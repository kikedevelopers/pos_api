import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Wrapper de respuesta exigido por el contrato PlacePos:
 *
 *     { "success": true, "payload": <T> }
 *
 * Cualquier valor que un controller retorne (objeto, array, string, number,
 * `undefined`) se envuelve aquí. `undefined` → `payload: null` (esperado por
 * el frontend para endpoints sin body, ej. `POST /auth/logout`).
 *
 * NO se aplica a errores — esos los formatea `AllExceptionsFilter`.
 *
 * NOTA: si en algún endpoint ya devuelves `{ success, payload }` manualmente,
 * acabará envuelto dos veces. Devuelve siempre datos crudos desde el handler.
 */
export interface SuccessEnvelope<T> {
  success: true;
  payload: T;
}

@Injectable()
export class ResponseWrapperInterceptor<T> implements NestInterceptor<
  T,
  SuccessEnvelope<T | null>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessEnvelope<T | null>> {
    return next.handle().pipe(
      map((payload) => ({
        success: true as const,
        payload: payload ?? null,
      })),
    );
  }
}
