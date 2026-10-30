import { registerAs } from '@nestjs/config';

/**
 * Configuración de la integración de WhatsApp (Cloud API de Meta) para el bot
 * VENDEDOR. A diferencia de Telegram (long-polling, token por negocio), WhatsApp
 * funciona por WEBHOOK y cuelga de UNA sola app de Meta ("PlacePOS Asistente"):
 *
 *  - El webhook es único (lo llama Meta). Se valida con `appSecret` (firma
 *    `X-Hub-Signature-256`) y con `verifyToken` (reto GET de verificación).
 *  - El envío usa un token de acceso (de la app/usuario de sistema). Por defecto
 *    se usa este `accessToken` compartido; un negocio puede traer el suyo propio
 *    (guardado en su config) y entonces se usa ese.
 *
 * Cada negocio solo configura su `phone_number_id` (el número que registró bajo
 * la app). El ruteo del webhook al negocio correcto se hace por ese id.
 *
 * Secretos (appSecret, accessToken) viven SOLO en el servidor.
 */
export interface WhatsappConfig {
  /** Secreto de la app de Meta — valida la firma del webhook. */
  appSecret: string;
  /** Token del reto de verificación del webhook (lo defines tú en Meta). */
  verifyToken: string;
  /** Token de acceso compartido para enviar mensajes (Graph API). */
  accessToken: string;
  /** Versión de la Graph API (ej. "v21.0"). */
  graphApiVersion: string;
}

export default registerAs<WhatsappConfig>('whatsapp', () => ({
  appSecret: process.env.WHATSAPP_APP_SECRET?.trim() ?? '',
  verifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim() ?? '',
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? '',
  graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || 'v21.0',
}));
