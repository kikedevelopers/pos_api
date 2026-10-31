import { randomUUID } from 'crypto';

import Big from 'big.js';

/**
 * Carrito del vendedor: el pedido EN CURSO de una conversación. Funciones puras
 * (sin BD) para poder probarlas; el `SellerCartService` las persiste.
 *
 * Los precios los pone SIEMPRE el servidor (nivel por defecto del producto):
 * el modelo solo dice qué producto y cuántos. Decimales como string exacto.
 *
 * Cerrar el pedido NO crea venta ni pedido en el POS: se le AVISA al dueño con
 * el detalle (la creación en el POS queda para una fase posterior).
 */

export type DeliveryMode = 'domicilio' | 'recoger';

export const DELIVERY_MODES: readonly DeliveryMode[] = ['domicilio', 'recoger'];

/**
 * Entregas que ofrece el negocio (ajuste "Entregas" del agente).
 * `deliveryAvailable` omitido = sí hace domicilios (compatibilidad).
 */
export interface DeliveryOptions {
  /** Se puede recoger en el negocio. */
  pickupAvailable: boolean;
  /** Hace envíos a domicilio. */
  deliveryAvailable?: boolean;
}

const offersDelivery = (options: DeliveryOptions): boolean => options.deliveryAvailable !== false;

/** ¿El negocio ofrece esta forma de entrega? */
export const isDeliveryModeOffered = (mode: DeliveryMode, options: DeliveryOptions): boolean =>
  mode === 'recoger' ? options.pickupAvailable : offersDelivery(options);

/**
 * Entrega del pedido según lo que ofrece el negocio: si ofrece una sola, es
 * esa (sin preguntar); si ofrece las dos, la que eligió el cliente (o
 * `undefined` si aún no la dijo). Un modo que el negocio no ofrece nunca sale.
 */
export const resolveDeliveryMode = (
  details: OrderDetails,
  options: DeliveryOptions,
): DeliveryMode | undefined => {
  const pickup = options.pickupAvailable;
  const delivery = offersDelivery(options);
  if (pickup && !delivery) return 'recoger';
  if (!pickup) return 'domicilio';
  return details.delivery_mode;
};

export interface CartItem {
  product_id: number;
  /** Nombre EXACTO del catálogo (lo que ve el dueño en el aviso). */
  name: string;
  /** 4 decimales. */
  quantity: string;
  /** 2 decimales. */
  unit_price: string;
  /** 2 decimales. */
  total: string;
}

/** Datos para despachar el pedido que el cliente fue dando. */
export interface OrderDetails {
  customer_name?: string;
  customer_phone?: string;
  delivery_mode?: DeliveryMode;
  delivery_address?: string;
  payment_method?: string;
  notes?: string;
}

/** Último pedido cerrado (avisado al dueño) en esta conversación. */
export interface LastPlacedOrder {
  /** Referencia corta del pedido ("P-4F2A9C1B"), para el cliente y el dueño. */
  reference: string;
  /** Id en `sales_agent_orders` (para modificarlo o cancelarlo). Carritos viejos: no viene. */
  order_id?: string;
  total: string;
  placed_at: string;
}

export interface SellerCart {
  items: CartItem[];
  details: OrderDetails;
  /** Identificador del PRÓXIMO pedido (UUID v4); se renueva tras cerrarlo. */
  operation_id: string;
  last_order?: LastPlacedOrder;
  /**
   * El carrito es una MODIFICACIÓN de un pedido ya cerrado (el cliente lo está
   * cambiando antes de que lo tomen): al confirmar se actualiza ESE pedido.
   */
  amends?: { order_id: string; reference: string };
  /** Última modificación (ISO): un carrito abandonado vence (`CART_TTL_MS`). */
  updated_at: string;
}

/** Un carrito sin cambios por más de esto se descarta (24 h). */
export const CART_TTL_MS = 24 * 60 * 60 * 1000;

/** `true` si el carrito venció (abandonado). */
export const isCartExpired = (cart: SellerCart, now: number = Date.now()): boolean => {
  const at = Date.parse(cart.updated_at);
  return !Number.isFinite(at) || now - at > CART_TTL_MS;
};

/** Líneas máximas de un carrito. */
export const MAX_CART_ITEMS = 40;

/** Cantidad máxima de una línea. */
export const MAX_CART_QUANTITY = new Big('100000');

/** Largo máximo de cada dato de entrega. */
const MAX_DETAIL_LENGTH: Record<keyof OrderDetails, number> = {
  customer_name: 120,
  customer_phone: 40,
  delivery_mode: 20,
  delivery_address: 250,
  payment_method: 60,
  notes: 250,
};

export const emptyCart = (now: Date = new Date()): SellerCart => ({
  items: [],
  details: {},
  operation_id: randomUUID(),
  updated_at: now.toISOString(),
});

/**
 * Cantidad válida o `null`. `0` = quitar.
 *
 * SIEMPRE unidades ENTERAS de la presentación: la presentación ya dice cuánto
 * trae ("X MEDIA LIBRA" ya es media libra → 1). Una fracción ("0.5" para decir
 * "media") cobraría media presentación; para fracciones se elige la
 * presentación que corresponde (media libra, cuarto, gramo). Se acepta "2.0".
 */
export const readCartQuantity = (raw: unknown): Big | null => {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+(\.0+)?$/.test(text)) {
    return null;
  }
  const quantity = new Big(text);
  return quantity.gt(MAX_CART_QUANTITY) ? null : quantity;
};

/** `true` si la línea tiene una cantidad fraccionada (carritos de antes de la regla). */
const isFractional = (item: CartItem): boolean =>
  !new Big(item.quantity).round(0).eq(item.quantity);

/**
 * Valor TOTAL en pesos de un pedido "por valor" ("2000 de pimienta" → 2000), o
 * `null` si no es un monto válido.
 */
export const readAmountRequested = (raw: unknown): Big | null => {
  const cleaned =
    typeof raw === 'number'
      ? String(raw)
      : typeof raw === 'string'
        ? raw.replace(/[$\s]/g, '')
        : '';
  // Puntos solo como separador de miles ("2.000"); "20.5" no es un monto en pesos.
  const text = /^\d{1,3}(\.\d{3})+$/.test(cleaned) ? cleaned.replace(/\./g, '') : cleaned;
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const amount = new Big(text);
  return amount.gt(0) && amount.lte(MAX_CART_QUANTITY.times(1000)) ? amount : null;
};

export const cartTotal = (cart: SellerCart): Big =>
  cart.items.reduce((sum, item) => sum.plus(item.total), new Big(0)).round(2);

/**
 * Pone la cantidad de un producto en el carrito (crea, reemplaza o, con
 * cantidad 0, quita la línea). Una línea por producto: repetir el producto
 * corrige la cantidad, no la suma (el modelo dice "ahora son 3").
 */
export const setCartItem = (
  cart: SellerCart,
  item: { product_id: number; name: string; unit_price: Big },
  quantity: Big,
): SellerCart => {
  const others = cart.items.filter((line) => line.product_id !== item.product_id);
  if (quantity.lte(0)) {
    return { ...cart, items: others };
  }
  const unitPrice = item.unit_price.round(2);
  const line: CartItem = {
    product_id: item.product_id,
    name: item.name,
    quantity: quantity.toFixed(4),
    unit_price: unitPrice.toFixed(2),
    total: unitPrice.times(quantity).round(2).toFixed(2),
  };
  const existingIndex = cart.items.findIndex((other) => other.product_id === item.product_id);
  if (existingIndex < 0) {
    return { ...cart, items: [...cart.items, line] };
  }
  const items = [...cart.items];
  items[existingIndex] = line;
  return { ...cart, items };
};

/** Mezcla datos de entrega: recorta, acota y descarta lo inválido o vacío. */
export const mergeOrderDetails = (cart: SellerCart, patch: Record<string, unknown>): SellerCart => {
  const details: OrderDetails = { ...cart.details };
  for (const key of Object.keys(MAX_DETAIL_LENGTH) as Array<keyof OrderDetails>) {
    const raw = patch[key];
    if (typeof raw !== 'string') {
      continue;
    }
    const value = raw.trim().slice(0, MAX_DETAIL_LENGTH[key]);
    if (!value) {
      continue;
    }
    if (key === 'delivery_mode') {
      const mode = value.toLowerCase() as DeliveryMode;
      if (DELIVERY_MODES.includes(mode)) {
        details.delivery_mode = mode;
      }
      continue;
    }
    details[key] = value;
  }
  return { ...cart, details };
};

/**
 * Qué falta para poder crear el pedido, en palabras para el modelo. Vacío =
 * listo para cerrar. Si el negocio ofrece una sola forma de entrega, el pedido
 * es con esa (solo recoger → nunca pide dirección).
 */
export const missingForCheckout = (cart: SellerCart, options: DeliveryOptions): string[] => {
  const missing: string[] = [];
  if (cart.items.length === 0) {
    missing.push('productos');
  }
  const mode = resolveDeliveryMode(cart.details, options);
  if (!mode) {
    missing.push('si es a domicilio o lo recoge');
  } else if (mode === 'domicilio' && !cart.details.delivery_address) {
    missing.push('dirección de entrega');
  }
  if (!cart.details.customer_name) {
    missing.push('nombre de quien recibe');
  }
  // Un carrito armado antes de la regla de unidades enteras no se cierra sin
  // corregirlo: cobraría fracciones de presentación.
  const fractional = cart.items.filter(isFractional);
  if (fractional.length > 0) {
    missing.push(
      `corregir cantidades fraccionadas (${fractional.map((item) => item.name).join(', ')}): van en unidades enteras de la presentación`,
    );
  }
  return missing;
};

/** Referencia corta y legible de un pedido a partir de su identificador. */
export const orderReference = (operationId: string): string =>
  `P-${operationId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

const quantityLabel = (quantity: string): string => new Big(quantity).toString();

const money = (value: Big | string): string => {
  const rounded = Math.round(Number(new Big(value).toString()));
  return `$ ${rounded.toLocaleString('es-CO')}`;
};

/** Vista del carrito que se le devuelve al modelo tras cada cambio. */
export const cartView = (cart: SellerCart, options: DeliveryOptions): Record<string, unknown> => ({
  items: cart.items.map((item) => ({
    product_id: item.product_id,
    name: item.name,
    quantity: Number(item.quantity),
    unit_price: Number(item.unit_price),
    total: Number(item.total),
  })),
  total: Number(cartTotal(cart).toString()),
  details: cart.details,
  missing_to_close: missingForCheckout(cart, options),
});

/**
 * Bloque "Pedido en curso" del prompt: el modelo lo ve en CADA turno, así no
 * depende de recordar lo que el cliente ya pidió ni de releer la charla.
 */
export const describeCartForPrompt = (
  cart: SellerCart | null,
  options: DeliveryOptions,
): string => {
  if (!cart || cart.items.length === 0) {
    const last = cart?.last_order
      ? `\nYa le tomaste un pedido en esta conversación (${cart.last_order.reference}, ${money(cart.last_order.total)}). Si quiere CAMBIAR algo de ESE pedido (quitar, agregar, cambiar cantidades, entrega o pago), usa modify_last_order; si quiere CANCELARLO, cancel_last_order. NUNCA armes un pedido nuevo para cambiar el anterior. Solo si pide una compra aparte, claramente distinta, es un pedido NUEVO.`
      : '';
    return `# Pedido en curso
El carrito está vacío. Etapa: ENTENDER la necesidad y PROPONER.${last}`;
  }

  const lines = cart.items.map(
    (item) =>
      `- ${quantityLabel(item.quantity)} × ${item.name} (id ${item.product_id}) a ${money(item.unit_price)} = ${money(item.total)}`,
  );
  const details = cart.details;
  const known = [
    details.customer_name ? `Recibe: ${details.customer_name}` : null,
    details.customer_phone ? `Tel: ${details.customer_phone}` : null,
    details.delivery_mode ? `Entrega: ${details.delivery_mode}` : null,
    details.delivery_address ? `Dirección: ${details.delivery_address}` : null,
    details.payment_method ? `Pago: ${details.payment_method}` : null,
    details.notes ? `Notas: ${details.notes}` : null,
  ].filter(Boolean);
  const missing = missingForCheckout(cart, options);
  const stage =
    missing.length === 0
      ? 'LISTO PARA CERRAR: resume (productos, total, entrega) y pide el "sí" para crear el pedido.'
      : `ARMANDO EL PEDIDO. Falta: ${missing.join(', ')}. Pídelo de forma natural, una cosa a la vez.`;

  const amending = cart.amends
    ? `Estás MODIFICANDO el pedido ${cart.amends.reference} que el cliente ya había hecho (no es uno nuevo). Ajusta lo que pidió cambiar, muéstrale el resumen y, con su "sí", close_order lo ACTUALIZA con la misma referencia.\n`
    : '';
  return `# Pedido en curso
${amending}${lines.join('\n')}
Total: ${money(cartTotal(cart))}
${known.length > 0 ? `Datos: ${known.join(' · ')}` : 'Datos de entrega: ninguno todavía.'}
Etapa: ${stage}`;
};
