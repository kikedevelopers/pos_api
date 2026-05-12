import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Envoltura estándar de respuestas exitosas: `{ data, meta }`.
 *
 * NOTA DE DISEÑO:
 * Este interceptor se deja como OPT-IN (no se aplica globalmente).
 * Justificación:
 *  - No todos los endpoints quieren un envoltorio (ej: health-checks, streams, archivos).
 *  - Aplicarlo global complica la integración con clientes que ya esperan la forma cruda
 *    devuelta por el handler.
 *  - Usándolo a nivel de controlador (`@UseInterceptors(TransformInterceptor)`) o método
 *    se obtiene control fino.
 */
export interface StandardResponse<T> {
  data: T;
  meta: {
    timestamp: string;
  };
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, StandardResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<StandardResponse<T>> {
    return next.handle().pipe(
      map((data) => ({
        data,
        meta: {
          timestamp: new Date().toISOString(),
        },
      })),
    );
  }
}
