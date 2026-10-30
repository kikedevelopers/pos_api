import { registerAs } from '@nestjs/config';

/**
 * Configuración del "vendedor" Place en canales de chat (Telegram hoy; WhatsApp
 * más adelante). Es un módulo AISLADO del asistente del dueño (`ai`): aquí Place
 * atiende CLIENTES finales, no al comerciante. Reutiliza el mismo Gemini pero
 * con persona, prompt y herramientas propios (solo lectura de inventario).
 *
 * Secretos (token del bot) viven SOLO en el servidor, igual que la llave de
 * Gemini. El canal del cliente nunca los ve.
 */
export interface SalesBotConfig {
  /** Apaga el módulo entero sin desmontarlo (no arranca el poller de Telegram). */
  enabled: boolean;
  /**
   * Negocio (company) al que atiende el bot. En esta v1 un bot = un negocio;
   * el ruteo multi-negocio (un bot para varias sucursales) llega después.
   */
  companyId: number | null;
  /** Modelo de Gemini para el vendedor (por defecto, el Flash-Lite de `ai`). */
  model: string;
  temperature: number;
  maxOutputTokens: number;
  /** Rondas de function calling antes de obligar a responder. Evita bucles. */
  maxToolRounds: number;
  /**
   * Presupuesto de "razonamiento" (thinking) del modelo, en tokens. El vendedor
   * usa razonamiento BAJO para responder rápido sin perder criterio. OJO: con
   * herramientas (function calling) este modelo RECHAZA 0 (error 400); debe ser
   * > 0. Por eso el default es bajo pero no nulo.
   */
  thinkingBudget: number;
  telegram: {
    /** Token del bot de @BotFather. Vacío = el poller de Telegram no arranca. */
    token: string;
    /** Cada cuánto consulta getUpdates (long-polling). */
    pollIntervalMs: number;
    /** Timeout del long-poll en el lado de Telegram (segundos). */
    longPollTimeoutSec: number;
    /**
     * Chat de Telegram del dueño al que Place AVISA cada pedido cerrado. Vacío =
     * el pedido solo se registra en el log del servidor.
     */
    ownerChatId: string;
  };
}

export default registerAs<SalesBotConfig>('salesBot', () => {
  const companyIdRaw = process.env.SALES_BOT_COMPANY_ID?.trim();
  const companyId =
    companyIdRaw && /^\d+$/.test(companyIdRaw) ? Number.parseInt(companyIdRaw, 10) : null;

  return {
    enabled: process.env.SALES_BOT_ENABLED?.trim() === 'true',
    companyId,
    // Vacío = usa el modelo por defecto de Gemini (Flash-Lite): rápido por SSE y
    // probado por el chat del dueño. Configurable con SALES_BOT_MODEL.
    model: process.env.SALES_BOT_MODEL?.trim() || '',
    temperature: Number.parseFloat(process.env.SALES_BOT_TEMPERATURE ?? '0.8'),
    maxOutputTokens: Number.parseInt(process.env.SALES_BOT_MAX_OUTPUT_TOKENS ?? '2048', 10),
    maxToolRounds: Number.parseInt(process.env.SALES_BOT_MAX_TOOL_ROUNDS ?? '4', 10),
    thinkingBudget: Number.parseInt(process.env.SALES_BOT_THINKING_BUDGET ?? '128', 10),
    telegram: {
      token: process.env.SALES_BOT_TELEGRAM_TOKEN?.trim() ?? '',
      pollIntervalMs: Number.parseInt(process.env.SALES_BOT_TELEGRAM_POLL_INTERVAL_MS ?? '1500', 10),
      longPollTimeoutSec: Number.parseInt(
        process.env.SALES_BOT_TELEGRAM_LONG_POLL_TIMEOUT_SEC ?? '30',
        10,
      ),
      ownerChatId: process.env.SALES_BOT_TELEGRAM_OWNER_CHAT_ID?.trim() ?? '',
    },
  };
});
