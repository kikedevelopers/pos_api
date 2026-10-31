/**
 * Alertas del agente de ventas (pedidos de clientes): traen datos personales
 * del cliente, así que las ve el mismo público que el informe "Agente" (nivel
 * administrador). Al resto se le ocultan del listado y del contador.
 */
export const AGENT_ORDER_ALERT_PREFIX = 'AGENT_ORDER_';

export const AGENT_ORDER_ALERT_TYPES = {
  NEW: 'AGENT_ORDER_NEW',
  UPDATED: 'AGENT_ORDER_UPDATED',
  CANCELLED: 'AGENT_ORDER_CANCELLED',
  REQUEST: 'AGENT_ORDER_REQUEST',
} as const;

export type AgentOrderAlertType =
  (typeof AGENT_ORDER_ALERT_TYPES)[keyof typeof AGENT_ORDER_ALERT_TYPES];

/** Qué tipos ocultar a este usuario (`null` = ve todo). */
export const hiddenAlertPrefixFor = (isAdminLevel: boolean): string | null =>
  isAdminLevel ? null : AGENT_ORDER_ALERT_PREFIX;
