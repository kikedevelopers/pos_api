/**
 * Memoria del comportamiento REAL del correo en este proceso: cuántos salieron,
 * cuántos fallaron y qué dijo el último fallo.
 *
 * `verify()` responde "las credenciales sirven"; esto responde "los correos
 * están saliendo", que es la pregunta que de verdad importa en el panel. Vive
 * en memoria a propósito: no hay tabla ni migración, y se reinicia con el
 * proceso (el panel siempre muestra el estado del despliegue vigente).
 */

export interface MailActivitySnapshot {
  sentCount: number;
  failedCount: number;
  /** ISO del último envío aceptado por el proveedor. */
  lastSuccessAt: string | null;
  /** ISO del último fallo. */
  lastErrorAt: string | null;
  /** Mensaje del último fallo, ya traducido al español. */
  lastErrorMessage: string | null;
  /**
   * Fallos consecutivos desde el último envío bueno. > 0 con `sentCount` alto
   * es la señal de "esto se rompió hace poco", que un contador plano esconde.
   */
  consecutiveFailures: number;
}

const emptySnapshot = (): MailActivitySnapshot => ({
  sentCount: 0,
  failedCount: 0,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  consecutiveFailures: 0,
});

/**
 * Contador de envíos del proceso. Sin dependencias de Nest ni de reloj global:
 * el `now` se inyecta para poder testearlo con fechas fijas.
 */
export class MailStatusStore {
  private state: MailActivitySnapshot = emptySnapshot();

  recordSuccess(now: Date = new Date()): void {
    this.state = {
      ...this.state,
      sentCount: this.state.sentCount + 1,
      lastSuccessAt: now.toISOString(),
      consecutiveFailures: 0,
    };
  }

  recordFailure(message: string, now: Date = new Date()): void {
    this.state = {
      ...this.state,
      failedCount: this.state.failedCount + 1,
      lastErrorAt: now.toISOString(),
      lastErrorMessage: message,
      consecutiveFailures: this.state.consecutiveFailures + 1,
    };
  }

  snapshot(): MailActivitySnapshot {
    return { ...this.state };
  }

  reset(): void {
    this.state = emptySnapshot();
  }
}

/** Semáforo del panel. */
export type MailStatusLevel = 'ok' | 'warning' | 'error' | 'disabled';

/**
 * Traduce (salud del proveedor + actividad real) a un semáforo con su frase.
 * Puro: es la lógica que decide de qué color se pinta el panel, así que se
 * testea sola, sin red.
 */
export const resolveMailStatusLevel = ({
  configured,
  healthy,
  driver,
  activity,
}: {
  configured: boolean;
  healthy: boolean;
  driver: string;
  activity: MailActivitySnapshot;
}): { level: MailStatusLevel; summary: string } => {
  if (!configured) {
    return {
      level: 'disabled',
      summary: 'Sin credenciales: el servidor no puede enviar correos.',
    };
  }

  if (driver === 'log') {
    return {
      level: 'warning',
      summary: 'Modo local: los correos se escriben en el log y no se envían.',
    };
  }

  if (!healthy) {
    return { level: 'error', summary: 'El proveedor de correo no está respondiendo bien.' };
  }

  // Credenciales buenas pero envíos fallando: es el caso más traicionero
  // (dominio sin verificar, límite alcanzado) y el que hay que gritar.
  if (activity.consecutiveFailures > 0) {
    return {
      level: 'error',
      summary:
        activity.consecutiveFailures === 1
          ? 'El último correo no se pudo enviar.'
          : `Los últimos ${activity.consecutiveFailures} correos no se pudieron enviar.`,
    };
  }

  if (activity.failedCount > 0) {
    return {
      level: 'warning',
      summary: `Operativo, con ${activity.failedCount} fallo(s) anteriores ya superados.`,
    };
  }

  return { level: 'ok', summary: 'Operativo: los correos están saliendo.' };
};
