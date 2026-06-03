import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { RealtimeGateway } from './realtime.gateway';

/**
 * Interceptor GLOBAL de invalidación del dashboard en tiempo real.
 *
 * Tras CUALQUIER mutación HTTP exitosa (método != GET) hecha por un usuario con
 * tenant, emite `dashboard:changed` a la company del actor para que owner/manager
 * invaliden los informes del dashboard. Un solo punto cubre ventas, gastos,
 * cajas, compras, abonos, transferencias, anulaciones, etc.
 *
 * Decisiones:
 *   - Solo NO-GET: los GET no mutan estado, no invalidan informes.
 *   - Solo tras ÉXITO: el `tap` del stream de respuesta corre cuando el handler
 *     resolvió sin error (en error, el operador no se ejecuta).
 *   - `companyId` SIEMPRE de `req.user` (JWT verificado por `JwtAuthGuard`),
 *     jamás del cliente. Sin company (login, superadmin sin tenant) → no emite.
 *   - Best-effort: un fallo de socket NUNCA debe afectar la respuesta HTTP.
 *
 * La sobre-invalidación es barata: el cliente hace debounce y solo refetchea si
 * el dashboard está montado.
 */
@Injectable()
export class RealtimeInvalidationInterceptor implements NestInterceptor {
  constructor(private readonly gateway: RealtimeGateway) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    return next.handle().pipe(
      tap(() => {
        // Solo mutaciones (no GET). Idempotente con cualquier verbo de escritura.
        if (request.method === 'GET') {
          return;
        }

        const companyId = request.user?.company_id;
        // Sin tenant (login, superadmin sin company) → nada que invalidar.
        if (typeof companyId !== 'number' || companyId <= 0) {
          return;
        }

        // Best-effort: aislar el emit de socket de la respuesta HTTP.
        try {
          this.gateway.emitDashboardChanged(companyId);
        } catch {
          // Silenciado por diseño: la señal de tiempo real nunca rompe la
          // operación de negocio ya confirmada.
        }
      }),
    );
  }
}
