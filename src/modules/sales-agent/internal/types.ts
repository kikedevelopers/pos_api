/** Una línea de un pedido cerrado por el vendedor. */
export interface ClosedOrderItem {
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

/** Pedido que Place cerró en el chat; se le avisa al dueño (v1: no escribe POS). */
export interface ClosedOrder {
  items: ClosedOrderItem[];
  total: number;
  customer_name?: string;
  customer_phone?: string;
  delivery?: string;
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
}
