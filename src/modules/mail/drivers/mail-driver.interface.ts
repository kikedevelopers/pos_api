/**
 * CONTRATO DEL PROVEEDOR DE CORREO.
 *
 * Es la frontera del módulo: todo lo que hay por encima (`MailService`, las
 * plantillas, los controladores) habla SOLO con esta interfaz y nunca con
 * Resend, con SMTP ni con quien venga mañana.
 *
 * Cambiar de proveedor = escribir un archivo que implemente `MailDriver` y
 * añadir su rama en `createMailDriver` (ver `mail-driver.factory.ts`). No hay
 * un tercer sitio que tocar.
 */

/** Un correo listo para salir. Direcciones ya normalizadas y validadas. */
export interface MailMessage {
  to: string[];
  subject: string;
  html: string;
  /** Alternativa en texto plano (obligatoria: mejora entregabilidad). */
  text: string;
  /** Remitente. Si se omite, el driver usa `MAIL_FROM`. */
  from?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
}

/** Resultado de un envío aceptado por el proveedor. */
export interface MailSendResult {
  /** Id del mensaje en el proveedor, si lo devuelve. */
  messageId: string | null;
  /** Nombre del driver que lo envió (`resend`, `smtp`, `log`…). */
  provider: string;
  /** Cuánto tardó la llamada al proveedor. */
  durationMs: number;
}

/** Diagnóstico del proveedor: ¿está en pie y con credenciales válidas? */
export interface MailDriverHealth {
  healthy: boolean;
  /** Explicación en español, apta para mostrar en el panel. */
  detail: string;
  latencyMs: number | null;
}

/**
 * Fallo de envío ya traducido. `retriable` distingue una caída pasajera del
 * proveedor (reintentar tiene sentido) de un rechazo definitivo (credencial
 * inválida, destinatario mal escrito, dominio sin verificar).
 */
export class MailDeliveryError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retriable = false,
    /** Detalle técnico crudo: va al log, NUNCA al usuario final. */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

export interface MailDriver {
  /** Identificador estable del proveedor. Aparece en el panel y en los logs. */
  readonly name: string;
  /**
   * `false` cuando faltan credenciales. El servicio responde 503 en vez de
   * intentar un envío condenado a fallar.
   */
  isConfigured(): boolean;
  /** Envía el correo. Lanza `MailDeliveryError` si el proveedor lo rechaza. */
  send(message: MailMessage): Promise<MailSendResult>;
  /**
   * Comprueba credenciales/conectividad SIN enviar nada. Nunca lanza: un
   * proveedor caído se reporta como `healthy: false`, no como excepción.
   */
  verify(): Promise<MailDriverHealth>;
}

/** Token de inyección del driver activo. */
export const MAIL_DRIVER = Symbol('MAIL_DRIVER');
