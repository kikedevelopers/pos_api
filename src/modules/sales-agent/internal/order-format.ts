import type { ClosedOrder } from './types';

/** Formatea pesos colombianos con separador de miles ("$ 12.000"). */
export const formatCop = (value: number): string => {
  const rounded = Math.round(value);
  const withSep = rounded.toLocaleString('es-CO');
  return `$ ${withSep}`;
};

/** Firma estable de un pedido (líneas + total) para detectar un doble cierre. */
export const orderSignature = (order: ClosedOrder): string => {
  const lines = order.items
    .map((item) => `${item.name}|${item.quantity}|${item.unit_price}`)
    .sort()
    .join(';');
  return `${lines}#${order.total}`;
};

/**
 * Mensaje que recibe el DUEÑO cuando el vendedor cierra un pedido. Pensado para
 * leerse de un vistazo en el chat: qué pidieron, cuánto, y cómo ubicar al cliente.
 */
export const formatOrderForOwner = (order: ClosedOrder): string => {
  const label =
    order.kind === 'updated' ? '✏️ PEDIDO ACTUALIZADO POR EL CLIENTE' : '🛒 NUEVO PEDIDO';
  const title = order.reference
    ? `${label} ${order.reference} (asistente de ventas)`
    : `${label} (asistente de ventas)`;
  const lines: string[] = [title, ''];

  for (const item of order.items) {
    lines.push(
      `• ${item.quantity} × ${item.name} — ${formatCop(item.unit_price)} = ${formatCop(item.line_total)}`,
    );
  }

  lines.push('', `TOTAL: ${formatCop(order.total)}`, '');

  const contact: string[] = [];
  if (order.customer_name) {
    contact.push(`Cliente: ${order.customer_name}`);
  }
  if (order.customer_phone) {
    contact.push(`Tel: ${order.customer_phone}`);
  }
  if (order.delivery) {
    contact.push(`Entrega: ${order.delivery}`);
  }
  if (order.payment_method) {
    contact.push(`Pago: ${order.payment_method}`);
  }
  if (order.notes) {
    contact.push(`Notas: ${order.notes}`);
  }
  const origin =
    order.chat_display_name && order.chat_display_name.length > 0
      ? `${order.chat_display_name} · ${order.channel}`
      : `${order.channel} (${order.chat_id})`;
  contact.push(`Origen: ${origin}`);

  lines.push(...contact);
  return lines.join('\n');
};

/** Cómo está el pedido para el negocio ("ya está en PED-8303", "ya estaba descartado"). */
const lockedState = (order: { status: string; ticket: { number: string } | null }): string =>
  order.ticket
    ? `ya está en el ticket ${order.ticket.number}`
    : order.status === 'taken'
      ? 'ya fue tomado'
      : 'ya estaba descartado';

/** Aviso al negocio: el cliente canceló un pedido que nadie había tomado. */
export const formatCancelledNotice = (reference: string, reason: string | null): string =>
  [
    `❌ EL CLIENTE CANCELÓ EL PEDIDO ${reference} (asistente de ventas)`,
    reason ? `Motivo: ${reason}` : null,
  ]
    .filter(Boolean)
    .join('\n');

/**
 * Aviso al negocio: el cliente pide cambiar o cancelar un pedido que una
 * persona YA tomó. El agente no lo toca; el equipo lo atiende.
 */
export const formatTakenRequestNotice = (
  order: { reference: string; status: string; ticket: { number: string } | null },
  kind: 'change' | 'cancel',
  request: string,
): string =>
  [
    `⚠️ SOLICITUD DEL CLIENTE sobre ${order.reference} (${lockedState(order)})`,
    kind === 'cancel' ? 'Quiere CANCELAR el pedido.' : 'Quiere CAMBIAR el pedido.',
    request ? `Pidió: ${request}` : null,
    'Contáctalo para atenderla.',
  ]
    .filter(Boolean)
    .join('\n');
