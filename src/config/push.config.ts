import { registerAs } from '@nestjs/config';

/**
 * Notificaciones push de la PWA (Web Push con llaves VAPID). La llave pública
 * la pide la PWA para suscribirse; la privada firma cada envío y NUNCA sale del
 * servidor. Sin las dos llaves, el envío queda apagado (`enabled: false`).
 *
 * Generar: `npx web-push generate-vapid-keys`.
 */
export interface PushConfig {
  enabled: boolean;
  publicKey: string;
  privateKey: string;
  /** Contacto del remitente (`mailto:` o `https:`), lo exige el protocolo. */
  subject: string;
}

export default registerAs<PushConfig>('push', () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? '';
  return {
    enabled: publicKey.length > 0 && privateKey.length > 0,
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT?.trim() || 'mailto:soporte@kikedevs.com',
  };
});
