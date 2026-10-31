import { AlertSeverity } from '@/modules/app-alerts/entities/app-alert.entity';
import {
  AGENT_ORDER_ALERT_TYPES,
  type AgentOrderAlertType,
} from '@/modules/app-alerts/internal/alert-visibility';

/** Qué hizo el cliente con su pedido (cada evento genera una notificación). */
export type AgentOrderEventKind = 'new' | 'updated' | 'cancelled' | 'request';

export interface AgentOrderAlertData {
  order_id: string;
  reference: string;
  /** Pesos (número). */
  total: number;
  items_count: number;
  customer_name: string | null;
  channel: string;
  /** Motivo de la cancelación o texto de la solicitud. */
  detail?: string | null;
}

export interface AgentOrderAlert {
  type: AgentOrderAlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
}

const money = (value: number): string => `$ ${Math.round(value).toLocaleString('es-CO')}`;

const products = (count: number): string => (count === 1 ? '1 producto' : `${count} productos`);

/**
 * Notificación de la campana para un evento del cliente sobre su pedido. El
 * texto se lee de un vistazo: quién, qué pasó y cuánto. `metadata` lleva lo que
 * la UI necesita para abrir el pedido.
 */
export const buildAgentOrderAlert = (
  kind: AgentOrderEventKind,
  data: AgentOrderAlertData,
): AgentOrderAlert => {
  const who = data.customer_name?.trim() || 'Un cliente';
  const detail = data.detail?.replace(/\s+/g, ' ').trim() || null;
  const metadata = {
    order_id: Number(data.order_id),
    reference: data.reference,
    total: data.total,
    items_count: data.items_count,
    customer_name: data.customer_name,
    channel: data.channel,
    event: kind,
    ...(detail ? { detail } : {}),
  };

  switch (kind) {
    case 'new':
      return {
        type: AGENT_ORDER_ALERT_TYPES.NEW,
        severity: AlertSeverity.INFO,
        title: 'Nuevo pedido del agente',
        message: `${who} hizo el pedido ${data.reference} por ${money(data.total)} (${products(data.items_count)}).`,
        metadata,
      };
    case 'updated':
      return {
        type: AGENT_ORDER_ALERT_TYPES.UPDATED,
        severity: AlertSeverity.INFO,
        title: 'Pedido actualizado por el cliente',
        message: `${who} cambió el pedido ${data.reference}: ahora ${money(data.total)} (${products(data.items_count)}).`,
        metadata,
      };
    case 'cancelled':
      return {
        type: AGENT_ORDER_ALERT_TYPES.CANCELLED,
        severity: AlertSeverity.WARNING,
        title: 'El cliente canceló su pedido',
        message: `${who} canceló el pedido ${data.reference}${detail ? `: «${detail}»` : '.'}`,
        metadata,
      };
    case 'request':
      return {
        type: AGENT_ORDER_ALERT_TYPES.REQUEST,
        severity: AlertSeverity.WARNING,
        title: 'El cliente pide un cambio',
        message: `${who} pide sobre el pedido ${data.reference}, que ya estaba tomado${detail ? `: «${detail}»` : '.'}`,
        metadata,
      };
  }
};
