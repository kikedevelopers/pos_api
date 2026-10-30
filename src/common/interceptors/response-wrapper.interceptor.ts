import {
  CallHandler,
  ExecutionContext,
  Injectable,
  StreamableFile,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { RAW_RESPONSE_KEY } from '@/common/decorators/raw-response.decorator';

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
export class ResponseWrapperInterceptor<T>
  implements NestInterceptor<T, SuccessEnvelope<T | null> | StreamableFile | T>
{
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessEnvelope<T | null> | StreamableFile | T> {
    // `@RawResponse()` (handler o controller) → la respuesta se devuelve CRUDA,
    // sin envolver. La usa el webhook de WhatsApp, que debe responderle a Meta el
    // `hub.challenge` tal cual (texto plano), no `{success, payload}`.
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return next.handle().pipe(
      map((payload) => {
        if (raw) {
          return payload;
        }
        // Descargas binarias (StreamableFile, p. ej. el PDF de alertas) NO se
        // envuelven: envolverlas en `{success, payload}` serializaría el stream a
        // JSON y rompería el archivo. Se devuelven tal cual para que Nest las
        // transmita como binario.
        if (payload instanceof StreamableFile) {
          return payload;
        }
        return { success: true as const, payload: payload ?? null };
      }),
    );
  }
}
