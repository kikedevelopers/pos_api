/** Una línea de un pedido cerrado por el vendedor. */
export interface ClosedOrderItem {
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

/** Pedido que Place cerró en el chat; se le AVISA al dueño (no escribe en el POS). */
export interface ClosedOrder {
  /** Referencia corta del pedido ("P-4F2A9C1B"). */
  reference?: string;
  /** `updated`: el cliente modificó un pedido que ya había hecho (misma referencia). */
  kind?: 'new' | 'updated';
  items: ClosedOrderItem[];
  total: number;
  customer_name?: string;
  customer_phone?: string;
  delivery?: string;
  payment_method?: string;
  notes?: string;
  /** Identidad del cliente en el canal, para que el dueño pueda ubicarlo. */
  channel: string;
  chat_id: string;
  chat_display_name?: string;
}

/** Resultado de atender un mensaje: respuesta al cliente + pedidos cerrados. */
export interface SellerReply {
  reply: string;
  orders: ClosedOrder[];
  /** Avisos para el negocio (el cliente canceló, pide un cambio de un pedido tomado...). */
  notices?: string[];
  /**
   * La conversación está EN SILENCIO por mensajes fuera de tema y este tampoco
   * era del negocio: el canal NO responde nada.
   */
  silent?: boolean;
}
