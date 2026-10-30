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
  total: string;
  placed_at: string;
}

export interface SellerCart {
  items: CartItem[];
  details: OrderDetails;
  /** Identificador del PRÓXIMO pedido (UUID v4); se renueva tras cerrarlo. */
  operation_id: string;
  last_order?: LastPlacedOrder;
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

/** Cantidad válida (> 0, ≤ tope, máx. 4 decimales) o `null`. `0` = quitar. */
export const readCartQuantity = (raw: unknown): Big | null => {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return null;
  }
  const quantity = new Big(text);
  if (quantity.gt(MAX_CART_QUANTITY) || !quantity.round(4).eq(quantity)) {
    return null;
  }
  return quantity;
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
 * listo para cerrar. Sin punto físico (`pickupAvailable` false), el pedido es
 * siempre a domicilio.
 */
export const missingForCheckout = (
  cart: SellerCart,
  options: { pickupAvailable: boolean },
): string[] => {
  const missing: string[] = [];
  if (cart.items.length === 0) {
    missing.push('productos');
  }
  const mode = options.pickupAvailable ? cart.details.delivery_mode : 'domicilio';
  if (!mode) {
    missing.push('si es a domicilio o lo recoge');
  } else if (mode === 'domicilio' && !cart.details.delivery_address) {
    missing.push('dirección de entrega');
  }
  if (!cart.details.customer_name) {
    missing.push('nombre de quien recibe');
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
export const cartView = (
  cart: SellerCart,
  options: { pickupAvailable: boolean },
): Record<string, unknown> => ({
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
  options: { pickupAvailable: boolean },
): string => {
  if (!cart || cart.items.length === 0) {
    const last = cart?.last_order
      ? `\nYa le tomaste un pedido en esta conversación (${cart.last_order.reference}, ${money(cart.last_order.total)}). Si pide algo más, es un pedido NUEVO.`
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

  return `# Pedido en curso
${lines.join('\n')}
Total: ${money(cartTotal(cart))}
${known.length > 0 ? `Datos: ${known.join(' · ')}` : 'Datos de entrega: ninguno todavía.'}
Etapa: ${stage}`;
};
