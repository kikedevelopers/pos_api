/**
 * Parser PURO del payload del webhook de WhatsApp (Cloud API). Extrae solo lo
 * que nos importa: mensajes de TEXTO entrantes, con el `phone_number_id` del
 * número del negocio (clave de ruteo) y el nombre del remitente si viene.
 *
 * Ignora todo lo demás (estados de entrega `statuses`, imágenes, audios,
 * reacciones, etc.) devolviéndolo fuera de la lista. Nunca lanza: ante un
 * payload raro, devuelve lista vacía.
 */

export interface WhatsappIncomingMessage {
  /** Id del número del negocio que recibió el mensaje (ruteo al tenant). */
  phoneNumberId: string;
  /** Número visible del negocio (p. ej. "+57 300 1234567"), si viene. */
  displayPhoneNumber?: string;
  /** wa_id del cliente (su número, formato internacional sin +). */
  from: string;
  text: string;
  senderName?: string;
  messageId: string;
}

interface RawTextMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
}

interface RawValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: RawTextMessage[];
}

interface RawChange {
  field?: string;
  value?: RawValue;
}

interface RawEntry {
  changes?: RawChange[];
}

interface RawWebhookBody {
  object?: string;
  entry?: RawEntry[];
}

export function parseWhatsappWebhook(body: unknown): WhatsappIncomingMessage[] {
  const typed = body as RawWebhookBody | null | undefined;
  if (!typed || !Array.isArray(typed.entry)) return [];

  const out: WhatsappIncomingMessage[] = [];

  for (const entry of typed.entry) {
    if (!Array.isArray(entry?.changes)) continue;
    for (const change of entry.changes) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId || !Array.isArray(value?.messages)) continue;
      const displayPhoneNumber = value?.metadata?.display_phone_number?.trim() || undefined;

      // El nombre viene en contacts[], correlacionado por wa_id.
      const nameByWaId = new Map<string, string>();
      for (const contact of value?.contacts ?? []) {
        if (contact?.wa_id && contact.profile?.name) {
          nameByWaId.set(contact.wa_id, contact.profile.name);
        }
      }

      for (const message of value.messages) {
        if (message?.type !== 'text') continue;
        const text = message.text?.body?.trim();
        const from = message.from;
        const messageId = message.id;
        if (!text || !from || !messageId) continue;
        out.push({
          phoneNumberId,
          ...(displayPhoneNumber ? { displayPhoneNumber } : {}),
          from,
          text,
          senderName: nameByWaId.get(from),
          messageId,
        });
      }
    }
  }

  return out;
}
