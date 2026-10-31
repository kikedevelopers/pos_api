/**
 * Mensajes push (funciones puras). El service worker de la PWA lee este JSON y
 * muestra la notificación; al tocarla abre `url`.
 */

/** Lo que recibe el service worker de la PWA. */
export interface PushMessage {
  title: string;
  body: string;
  /** Ruta de la PWA que abre el toque. */
  url: string;
  /** Misma etiqueta = reemplaza la notificación anterior (un pedido, un aviso). */
  tag: string;
  /** Negocio donde pasó (la PWA sabe si es otra sucursal). */
  company_id: number;
  /** Pedido del agente, si aplica. */
  order_id?: number;
}

/** Evento de un pedido del agente que se avisa por push. */
export interface AgentOrderPush {
  company_id: number;
  company_name: string;
  order_id: number;
  title: string;
  body: string;
}

/** Ruta de la PWA que abre el pedido en Reportes → Agente. */
export const agentOrderUrl = (orderId: number): string =>
  `/reportes?tab=agente&order=${orderId}`;

/** Ruta de la PWA que abre el centro de notificaciones. */
export const NOTIFICATIONS_URL = '/?notifications=open';

/** Largo máximo del cuerpo (los SO lo recortan igual; ahorra bytes del payload). */
const MAX_BODY = 180;

const clip = (text: string, max: number): string => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/**
 * Mensaje de un pedido del agente para una suscripción. Si el dispositivo está
 * en OTRO negocio (el dueño parado en otra sucursal), el título lleva el nombre
 * de la sucursal y el toque abre el centro de notificaciones: ese pedido no se
 * puede abrir desde el negocio que tiene activo.
 */
export const buildAgentOrderPush = (
  event: AgentOrderPush,
  subscriptionCompanyId: number,
): PushMessage => {
  const otherBranch = subscriptionCompanyId !== event.company_id;
  return {
    title: otherBranch ? `${event.title} · ${event.company_name}` : event.title,
    body: clip(event.body, MAX_BODY),
    url: otherBranch ? NOTIFICATIONS_URL : agentOrderUrl(event.order_id),
    tag: `agent-order-${event.order_id}`,
    company_id: event.company_id,
    order_id: event.order_id,
  };
};

/** El servicio push dice que la suscripción ya no existe: hay que borrarla. */
export const isGoneSubscription = (statusCode: unknown): boolean =>
  statusCode === 404 || statusCode === 410;
