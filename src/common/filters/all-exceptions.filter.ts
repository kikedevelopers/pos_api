import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';

/**
 * Shape de respuesta de error — espejo de PlacePos:
 *
 *   { "success": false, "error": "...", "payload"?: { code?, details? } }
 *
 * - `error`     : mensaje legible en español. Para 5xx siempre genérico.
 * - `payload`   : opcional, solo cuando el caller necesita un `code` o
 *                 `details` programático (ej. `EMAIL_TAKEN`). Para 5xx nunca
 *                 se expone (no filtrar stack/contexto al cliente).
 */
interface ErrorEnvelope {
  success: false;
  error: string;
  payload?: { code?: string; details?: unknown };
}

/**
 * Filtro global. Convierte todo lo que escape de un handler en el shape de
 * error del contrato y lo loguea con Pino (vía `Logger`).
 *
 * Reglas:
 *   - `HttpException`        → respeta status + mensaje. Si el mensaje es
 *                              array (típico de `ValidationPipe`), va tal
 *                              cual en `error` (concatenado) y los detalles
 *                              en `payload.details`.
 *   - `ThrottlerException`   → 429 con mensaje en español.
 *   - Cualquier otro error   → 500 con `"Error interno del servidor"`. Stack
 *                              trace solo en log, nunca en respuesta.
 *
 *   - 4xx auth (401/403)     → log nivel `warn`.
 *   - 5xx                    → log nivel `error` con stack.
 *   - Resto 4xx              → log nivel `warn`.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    const { status, body, stack } = this.resolveError(exception);

    const logCtx = {
      method: request.method,
      path: request.url,
      statusCode: status,
      requestId: request.id,
    };

    // `status` viene como `number` plano de NestJS. Comparamos con literales
    // numéricos para evitar `no-unsafe-enum-comparison` con HttpStatus.
    if (status >= 500) {
      // nestjs-pino no rendera el segundo argumento (trace) de Logger.error
      // como propiedad separada — para que el stack aparezca en el log,
      // lo concatenamos inline al mensaje. Sin esto, los 500 quedan opacos.
      this.logger.error(
        `${request.method} ${request.url} → ${status} ${body.error}${stack ? '\n' + stack : ''} ${JSON.stringify(logCtx)}`,
      );
    } else if (status === 401 || status === 403) {
      this.logger.warn(
        `${request.method} ${request.url} → ${status} ${body.error} ${JSON.stringify(logCtx)}`,
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} → ${status} ${body.error} ${JSON.stringify(logCtx)}`,
      );
    }

    response.status(status).json(body);
  }

  private resolveError(exception: unknown): {
    status: number;
    body: ErrorEnvelope;
    stack?: string;
  } {
    // Rate limit — `@nestjs/throttler` lanza HttpException con status 429.
    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        body: {
          success: false,
          error: 'Demasiadas solicitudes, intenta más tarde',
          payload: { code: 'RATE_LIMITED' },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();

      // String puro: HttpException('mensaje', status).
      if (typeof raw === 'string') {
        return {
          status,
          body: { success: false, error: raw },
        };
      }

      // Objeto: caso típico de NestJS o de ValidationPipe.
      const obj = raw as {
        message?: string | string[];
        error?: string;
        statusCode?: number;
        code?: string;
        details?: unknown;
        payload?: { code?: string; details?: unknown };
      };

      let errorMsg: string;
      let details: unknown;

      if (Array.isArray(obj.message)) {
        // ValidationPipe entrega array de errores legibles. Concatenamos en
        // `error` para mostrar algo legible y dejamos el array completo en
        // `payload.details` por si el frontend quiere mostrarlo por campo.
        errorMsg = obj.message.join('; ');
        details = obj.message;
      } else if (typeof obj.message === 'string') {
        errorMsg = obj.message;
      } else if (typeof obj.error === 'string') {
        errorMsg = obj.error;
      } else {
        errorMsg = exception.message || 'Error';
      }

      // Soporta dos vías de inyectar `code`/`details`:
      //   1) Lanzar `new ConflictException({ message, code, details })`.
      //   2) Lanzar `new ConflictException({ message, payload: { code, details } })`.
      const code = obj.payload?.code ?? obj.code;
      if (details === undefined) {
        details = obj.payload?.details ?? obj.details;
      }

      const body: ErrorEnvelope = { success: false, error: errorMsg };
      if (code !== undefined || details !== undefined) {
        body.payload = {};
        if (code !== undefined) {
          body.payload.code = code;
        }
        if (details !== undefined) {
          body.payload.details = details;
        }
      }

      return { status, body };
    }

    // Error desconocido. 500 genérico; el detalle queda en log.
    const stack = exception instanceof Error ? exception.stack : undefined;
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { success: false, error: 'Error interno del servidor' },
      stack,
    };
  }
}
