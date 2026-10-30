import type { ClosedOrder } from './types';

/** Formatea pesos colombianos con separador de miles ("$ 12.000"). */
export const formatCop = (value: number): string => {
  const rounded = Math.round(value);
  const withSep = rounded.toLocaleString('es-CO');
  return `$ ${withSep}`;
};

/**
 * Mensaje que recibe el DUEÑO cuando el vendedor cierra un pedido. Pensado para
 * leerse de un vistazo en el chat: qué pidieron, cuánto, y cómo ubicar al cliente.
 */
export const formatOrderForOwner = (order: ClosedOrder): string => {
  const lines: string[] = ['🛒 NUEVO PEDIDO (Place vendedor)', ''];

  for (const item of order.items) {
    lines.push(
      `• ${item.quantity} × ${item.name} — ${formatCop(item.unit_price)} = ${formatCop(item.line_total)}`,
    );
  }

  lines.push('', `TOTAL: ${formatCop(order.total)}`, '');

  const contact: string[] = [];
  if (order.customer_name) contact.push(`Cliente: ${order.customer_name}`);
  if (order.customer_phone) contact.push(`Tel: ${order.customer_phone}`);
  if (order.delivery) contact.push(`Entrega: ${order.delivery}`);
  if (order.notes) contact.push(`Notas: ${order.notes}`);
  const origin =
    order.chat_display_name && order.chat_display_name.length > 0
      ? `${order.chat_display_name} · ${order.channel}`
      : `${order.channel} (${order.chat_id})`;
  contact.push(`Origen: ${origin}`);

  lines.push(...contact);
  return lines.join('\n');
};
