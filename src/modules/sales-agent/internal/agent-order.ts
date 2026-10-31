import type {
  SalesAgentOrderItem,
  SalesAgentOrderStatus,
} from '../entities/sales-agent-order.entity';
import type { DeliveryMode, DeliveryOptions, SellerCart } from './cart';
import { cartTotal, resolveDeliveryMode } from './cart';

/**
 * Funciones puras del pedido que cierra el agente (sin BD) para poder probarlas;
 * `SalesAgentOrdersService` las persiste.
 */

/** De dónde viene el pedido: conversación y cuenta del negocio que atendió. */
export interface AgentOrderOrigin {
  /** Canal de la conversación (`telegram`, `whatsapp`, `whatsapp-web`). */
  channel: string;
  chatId: string;
  chatDisplayName?: string;
  /** Cuenta del negocio en el canal (`@usuario_bot`, número de WhatsApp). */
  channelAccount?: string;
  /**
   * Número del cliente cuando el canal lo da aparte: en WhatsApp con identidad
   * oculta (`@lid`) el id del chat no trae el número; el escritorio lo resuelve.
   */
  chatPhone?: string;
}

/** Fila lista para insertar en `sales_agent_orders`. */
export interface AgentOrderRecord {
  operation_id: string;
  reference: string;
  channel: string;
  channel_account: string | null;
  chat_id: string;
  chat_display_name: string | null;
  chat_phone: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_mode: DeliveryMode;
  delivery_address: string | null;
  payment_method: string | null;
  notes: string | null;
  items: SalesAgentOrderItem[];
  items_count: number;
  /** 2 decimales. */
  total: string;
}

const clip = (value: string | undefined | null, max: number): string | null => {
  const text = value?.trim() ?? '';
  return text ? text.slice(0, max) : null;
};

/** Dígitos de un teléfono internacional (7-15), o `null`. */
const validPhone = (raw: string | undefined): string | null => {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
};

/**
 * Número del cliente según el canal. WhatsApp lo da en el id del chat (Cloud API:
 * el `wa_id`; WhatsApp por QR: `573001234567@s.whatsapp.net`). Los chats `@lid`
 * (identidad oculta), los grupos y Telegram no traen número: `null`.
 */
export const chatPhoneOf = (channel: string, chatId: string): string | null => {
  const id = chatId.trim();
  if (channel === 'whatsapp') {
    const digits = id.replace(/\D/g, '');
    return /^\d{7,15}$/.test(id) ? digits : null;
  }
  if (channel === 'whatsapp-web') {
    const [user, server] = id.split('@');
    if (server !== 's.whatsapp.net' || !user) {
      return null;
    }
    const digits = user.split(':')[0].replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 ? digits : null;
  }
  return null;
};

/**
 * Arma la fila del pedido a partir del carrito que se está cerrando. La entrega
 * sale de lo que ofrece el negocio, igual que en el cierre.
 */
export const buildAgentOrderRecord = (
  cart: SellerCart,
  options: DeliveryOptions & { reference: string },
  origin: AgentOrderOrigin,
): AgentOrderRecord => {
  const details = cart.details;
  const mode: DeliveryMode = resolveDeliveryMode(details, options) ?? 'domicilio';
  return {
    operation_id: cart.operation_id,
    reference: options.reference,
    channel: origin.channel,
    channel_account: clip(origin.channelAccount, 120),
    chat_id: origin.chatId,
    chat_display_name: clip(origin.chatDisplayName, 120),
    chat_phone: validPhone(origin.chatPhone) ?? chatPhoneOf(origin.channel, origin.chatId),
    customer_name: clip(details.customer_name, 120),
    customer_phone: clip(details.customer_phone, 40),
    delivery_mode: mode,
    // Si lo recoge, la dirección no aplica (aunque el cliente la haya dado).
    delivery_address: mode === 'domicilio' ? clip(details.delivery_address, 250) : null,
    payment_method: clip(details.payment_method, 60),
    notes: clip(details.notes, 250),
    items: cart.items.map((item) => ({
      product_id: item.product_id,
      name: item.name,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total: item.total,
    })),
    items_count: cart.items.length,
    total: cartTotal(cart).toFixed(2),
  };
};

/**
 * Cambios de estado permitidos. Un pedido por tomar se toma o se descarta; uno
 * tomado o descartado puede volver a "por tomar" (deshacer), pero no saltar
 * directo entre tomado y descartado: así queda claro qué se deshizo.
 */
const TRANSITIONS: Record<SalesAgentOrderStatus, readonly SalesAgentOrderStatus[]> = {
  pending: ['taken', 'dismissed'],
  taken: ['pending'],
  dismissed: ['pending'],
};

export const canTransition = (from: SalesAgentOrderStatus, to: SalesAgentOrderStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** Nota del cambio de estado: recortada y acotada; vacía = `null`. */
export const normalizeStatusNote = (raw: unknown): string | null =>
  typeof raw === 'string' ? clip(raw, 250) : null;
