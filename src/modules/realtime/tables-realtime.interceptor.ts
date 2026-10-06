import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { RealtimeGateway } from './realtime.gateway';

/**
 * Emite `tables:changed` a la company tras CUALQUIER mutación exitosa (no GET)
 * del módulo "Salones y Mesas" (controllers de salons/restaurant-tables), para
 * que los clientes refresquen la lista y el selector "Enviar a" en tiempo real.
 *
 * Se aplica por controller con `@UseInterceptors(TablesRealtimeInterceptor)`.
 * Best-effort: un fallo de socket nunca afecta la respuesta HTTP.
 */
@Injectable()
export class TablesRealtimeInterceptor implements NestInterceptor {
  constructor(private readonly gateway: RealtimeGateway) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    return next.handle().pipe(
      tap(() => {
        if (request.method === 'GET') {
          return;
        }
        const companyId = request.user?.company_id;
        if (typeof companyId !== 'number' || companyId <= 0) {
          return;
        }
        try {
          this.gateway.emitTablesChanged(companyId);
        } catch {
          // Silenciado: la señal de tiempo real nunca rompe la operación.
        }
      }),
    );
  }
}
