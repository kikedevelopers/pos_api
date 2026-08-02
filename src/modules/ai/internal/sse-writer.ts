import type { Response } from 'express';

/**
 * Escritor SSE mínimo para el stream del chat.
 *
 * Detalles que importan:
 *   - `X-Accel-Buffering: no` evita que nginx acumule el stream y lo entregue
 *     de golpe al final (mata la sensación de "escribiendo").
 *   - `no-transform` evita que un proxy comprima/reescriba el cuerpo.
 *   - El heartbeat (`: ping`) mantiene viva la conexión con proxies que cortan
 *     por inactividad mientras el modelo piensa o consulta la base.
 */
export class SseWriter {
  private heartbeat?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly response: Response,
    heartbeatMs = 15_000,
  ) {
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();

    if (heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        if (!this.closed) {
          this.response.write(': ping\n\n');
        }
      }, heartbeatMs);
      // No debe mantener vivo el proceso por sí solo.
      this.heartbeat.unref?.();
    }
  }

  send(event: string, data: unknown): void {
    if (this.closed) {
      return;
    }
    this.response.write(`event: ${event}\n`);
    this.response.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
    }
    this.response.end();
  }
}
