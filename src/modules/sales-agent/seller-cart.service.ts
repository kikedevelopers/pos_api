import { randomUUID } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import Big from 'big.js';
import { DataSource, Repository } from 'typeorm';

import {
  priceLine,
  toSellableProduct,
  type SellableDetailRow,
  type SellableProduct,
} from '@/modules/ai/internal/sale-tool-helpers';
import { buildSellableDetailsSql } from '@/modules/ai/internal/sale-tool-sql';
import { accentInsensitiveLike } from '@/modules/ai/internal/tool-sql';
import { accessibleProductsPredicate } from '@/modules/products/internal/accessible-products.helper';

import { SalesBotConversationEntity } from './entities/sales-bot-conversation.entity';
import { buildAgentOrderRecord } from './internal/agent-order';
import {
  isPerGramProduct,
  productLineStem,
  resolveAmountRequest,
} from './internal/amount-request';
import { SELLABLE_SQL } from './internal/sellable-sql';
import {
  presentationGrams,
  readWeightRequested,
  resolveWeightRequest,
  weightLabel,
  type WeightCandidate,
  type WeightRequest,
} from './internal/weight-request';
import {
  MAX_CART_ITEMS,
  cartTotal,
  emptyCart,
  isCartExpired,
  mergeOrderDetails,
  missingForCheckout,
  orderReference,
  readCartQuantity,
  readAmountRequested,
  resolveDeliveryMode,
  setCartItem,
  type DeliveryOptions,
  type SellerCart,
} from './internal/cart';
import type { SessionKey } from './internal/session-store';
import type { ClosedOrder } from './internal/types';
import { SalesAgentOrdersService, type AgentOrderView } from './sales-agent-orders.service';

/** Opciones del negocio que afectan el cierre (entregas que ofrece). */
export type CartOptions = DeliveryOptions;

/** De dónde viene el pedido (para el aviso al dueño). */
export interface CartOrigin {
  channel: string;
  chatId: string;
  chatDisplayName?: string;
  /** Cuenta del negocio que atendió (`@usuario_bot`, número de WhatsApp). */
  channelAccount?: string;
  /** Número del cliente cuando el canal lo da aparte (chat `@lid`). */
  chatPhone?: string;
}

export type SetItemResult =
  | {
      status: 'ok';
      cart: SellerCart;
      /** Qué se anotó en un pedido por valor (para que el agente lo cuente igual). */
      note?: string;
    }
  | {
      status:
        | 'invalid_quantity'
        | 'invalid_amount'
        | 'amount_unavailable'
        | 'invalid_weight'
        | 'weight_unavailable'
        | 'weight_offer'
        | 'not_found'
        | 'no_price'
        | 'too_many_items';
      message: string;
    };

/** Pesos para los mensajes al modelo ("$ 2.000"). */
const cop = (value: Big): string =>
  `$ ${Math.round(Number(value.toString())).toLocaleString('es-CO')}`;

/** Tope de presentaciones de una línea que se evalúan en un pedido por valor. */
const MAX_LINE_CANDIDATES = 40;

const TOO_MANY_ITEMS = {
  status: 'too_many_items',
  message: `El carrito ya tiene ${MAX_CART_ITEMS} productos distintos; cierra este pedido antes de agregar más.`,
} as const;

const NOT_FOUND = {
  status: 'not_found',
  message:
    'Ese producto no está disponible para la venta. Búscalo de nuevo con search_products y usa el "id" de la presentación.',
} as const;

/** Precio por defecto de UNA unidad (la misma regla del POS), o `null` sin precio. */
const defaultUnitPrice = (product: SellableProduct): Big | null => {
  const priced = priceLine({
    product,
    quantity: new Big(1),
    price_level: null,
    manual_price: null,
    note: null,
    minimum_margin: null,
  });
  return priced.status === 'ok' ? new Big(priced.line.unit_price) : null;
};

export type CloseOrderResult =
  | { status: 'closed'; cart: SellerCart; order: ClosedOrder }
  | { status: 'missing_data'; cart: SellerCart; missing: string[] }
  | { status: 'price_changed'; cart: SellerCart; message: string }
  /** Se intentó actualizar un pedido que una persona ya tomó: no se tocó. */
  | { status: 'locked'; cart: SellerCart; order: AgentOrderView };

/** Pedido del cliente que ya no se puede cambiar (lo tomó una persona o se descartó). */
export interface LockedOrder {
  status: 'locked';
  order: AgentOrderView;
}

export type ReopenOrderResult =
  | { status: 'reopened'; cart: SellerCart }
  | { status: 'none' }
  | { status: 'cart_busy' }
  | LockedOrder;

export type CancelOrderResult =
  | { status: 'cancelled'; reference: string; cart: SellerCart }
  | { status: 'none' }
  | LockedOrder;

/**
 * Carrito del vendedor por conversación (columna `cart` de
 * `sales_bot_conversations`). El servidor pone los precios (nivel por defecto
 * del producto, la misma regla del POS), así el total que ve el cliente es real.
 *
 * Cerrar NO crea venta ni pedido en el POS: guarda el pedido en la bandeja del
 * informe "Agente" (`sales_agent_orders`) y lo devuelve para que el canal le
 * AVISE al dueño.
 */
@Injectable()
export class SellerCartService {
  private readonly logger = new Logger(SellerCartService.name);

  constructor(
    @InjectRepository(SalesBotConversationEntity)
    private readonly repo: Repository<SalesBotConversationEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly orders: SalesAgentOrdersService,
  ) {}

  /** Carrito vigente de la conversación (`null` si no hay o venció). */
  async get(key: SessionKey): Promise<SellerCart | null> {
    const row = await this.find(key);
    return row?.cart && !isCartExpired(row.cart) ? row.cart : null;
  }

  /**
   * Pone la cantidad de un producto (0 = quitarlo), con el precio del servidor.
   *
   * `rawAmount`: si el cliente pidió POR VALOR ("2000 de pimienta"), el valor
   * TOTAL en pesos. Entonces el SERVIDOR elige la presentación y la cantidad
   * (`resolveAmountRequest`): primero la de precio exacto, luego por gramos y
   * por último unidades fijas que sumen exacto. La cantidad del modelo se ignora.
   *
   * `rawWeight`: si pidió POR PESO en una medida ("1 @ de maní"), `{ quantity,
   * unit }`. El SERVIDOR busca la presentación de ese peso o su equivalencia
   * (`resolveWeightRequest`). La cantidad del modelo se ignora.
   */
  async setItem(
    key: SessionKey,
    productId: number,
    rawQuantity: unknown,
    rawAmount?: unknown,
    rawWeight?: unknown,
  ): Promise<SetItemResult> {
    if (rawAmount !== undefined && rawAmount !== null && rawAmount !== '') {
      const amount = readAmountRequested(rawAmount);
      if (amount === null) {
        return {
          status: 'invalid_amount',
          message:
            'NO se cambió el pedido. "amount_requested" debe ser el valor TOTAL en pesos que pidió el cliente, sin puntos ni signos (ej. 2000).',
        };
      }
      return this.setItemByAmount(key, productId, amount);
    }
    if (rawWeight !== undefined && rawWeight !== null) {
      const weight = readWeightRequested(rawWeight);
      if (weight === null) {
        return {
          status: 'invalid_weight',
          message:
            'NO se cambió el pedido. "weight_requested" es { quantity, unit } con unit = gramo, cuarto, media_libra, libra, kilo o arroba (ej. 1 @ = { quantity: 1, unit: "arroba" }).',
        };
      }
      return this.setItemByWeight(key, productId, weight);
    }

    const quantity = readCartQuantity(rawQuantity);
    if (quantity === null) {
      return {
        status: 'invalid_quantity',
        message:
          'NO se cambió el pedido. La cantidad son UNIDADES ENTERAS de esa presentación (1, 2, 3…; 0 = quitarla). La presentación ya dice cuánto trae: "X MEDIA LIBRA" ya es media libra, así que media libra = cantidad 1 de esa presentación, nunca 0.5 de otra. Para una fracción usa la presentación que corresponde (media libra, cuarto, gramo); si no existe, díselo al cliente y ofrécele las que hay. Si pidió por VALOR ("2000 de X"), usa amount_requested.',
      };
    }

    const cart = (await this.get(key)) ?? emptyCart();

    if (quantity.eq(0)) {
      return {
        status: 'ok',
        cart: await this.save(
          key,
          setCartItem(cart, { product_id: productId, name: '', unit_price: new Big(0) }, quantity),
        ),
      };
    }
    if (this.isFull(cart, productId)) {
      return TOO_MANY_ITEMS;
    }

    const product = await this.fetchProduct(key.companyId, productId);
    if (!product) {
      return NOT_FOUND;
    }
    const unitPrice = defaultUnitPrice(product);
    if (!unitPrice) {
      return {
        status: 'no_price',
        message: `${product.name} no tiene precio de venta configurado; no lo ofrezcas.`,
      };
    }

    const next = setCartItem(
      cart,
      { product_id: product.id, name: product.name, unit_price: unitPrice },
      quantity,
    );
    return { status: 'ok', cart: await this.save(key, next) };
  }

  /** Pedido por valor: el servidor elige presentación y cantidad. */
  private async setItemByAmount(
    key: SessionKey,
    productId: number,
    amount: Big,
  ): Promise<SetItemResult> {
    const chosen = await this.fetchProduct(key.companyId, productId);
    if (!chosen) {
      return NOT_FOUND;
    }
    const candidates = await this.lineCandidates(key.companyId, chosen);
    const resolution = resolveAmountRequest(amount, candidates, chosen.id);
    if (resolution.kind === 'none') {
      const options = candidates
        .filter((candidate) => !candidate.per_gram)
        .map((candidate) => `${candidate.name} (${cop(candidate.unit_price)})`)
        .join('; ');
      return {
        status: 'amount_unavailable',
        message: `NO se cambió el pedido. No hay forma de dar EXACTAMENTE ${cop(amount)} de ${productLineStem(chosen.name)}: no hay presentación de ese precio, ni por gramos, ni unidades que sumen exacto. Díselo al cliente y pregúntale cuál prefiere${options ? `: ${options}` : ''}. No escojas tú.`,
      };
    }

    const cart = (await this.get(key)) ?? emptyCart();
    if (this.isFull(cart, resolution.product.id)) {
      return TOO_MANY_ITEMS;
    }
    const next = setCartItem(
      cart,
      {
        product_id: resolution.product.id,
        name: resolution.product.name,
        unit_price: resolution.product.unit_price,
      },
      resolution.quantity,
    );
    const quantityLabel = resolution.quantity.toString();
    const note =
      resolution.kind === 'exact'
        ? `Pidió ${cop(amount)}: se anotó 1 × ${resolution.product.name} (precio exacto).`
        : resolution.kind === 'by_gram'
          ? `Pidió ${cop(amount)}: no hay presentación de ese precio, así que se anotaron ${quantityLabel} gramos (${resolution.product.name}) por ${cop(resolution.total)}, lo más cercano sin pasarse. Díselo al cliente tal cual.`
          : `Pidió ${cop(amount)}: no hay presentación de ese precio ni por gramos, así que se anotaron ${quantityLabel} × ${resolution.product.name} = ${cop(resolution.total)}. Díselo al cliente tal cual.`;
    return { status: 'ok', cart: await this.save(key, next), note };
  }

  /**
   * Pedido por peso: anota la presentación de ese peso (o la misma medida en
   * unidades); si solo cuadra una equivalencia (1 @ = 25 libras), NO la anota:
   * le dice al agente que se la ofrezca al cliente.
   */
  private async setItemByWeight(
    key: SessionKey,
    productId: number,
    weight: WeightRequest,
  ): Promise<SetItemResult> {
    const chosen = await this.fetchProduct(key.companyId, productId);
    if (!chosen) {
      return NOT_FOUND;
    }
    const asked = weightLabel(weight.quantity, weight.unit);
    const stem = productLineStem(chosen.name);
    const candidates = await this.lineCandidates(key.companyId, chosen);
    const resolution = resolveWeightRequest(weight, candidates, chosen.id);
    if (resolution.kind === 'none') {
      const options = candidates
        .filter((candidate) => !candidate.per_gram)
        .map((candidate) => `${candidate.name} (${cop(candidate.unit_price)})`)
        .join('; ');
      return {
        status: 'weight_unavailable',
        message: `NO se cambió el pedido. No hay forma de dar EXACTAMENTE ${asked} de ${stem} con las presentaciones que hay. Díselo al cliente y pregúntale cuál prefiere${options ? `: ${options}` : ''}. No escojas tú.`,
      };
    }

    const { product, quantity, total } = resolution;
    const how =
      resolution.kind === 'by_gram'
        ? `${quantity.toString()} gramos (${product.name}) a ${cop(product.unit_price)} el gramo`
        : `${quantity.toString()} × ${product.name} a ${cop(product.unit_price)} cada una`;

    if (!resolution.same_measure) {
      return {
        status: 'weight_offer',
        message: `NO se anotó todavía. ${stem} no se vende por esa medida: no hay presentación de ${asked}. Lo que sí hay: ${asked} = ${how} = ${cop(total)}. Explícaselo al cliente en pocas palabras (que por esa medida no se vende, pero sí así; cuánto le sale cada una, que eso suma ${asked} y el total) y pregúntale si así lo quiere. Si acepta, set_cart_item con product_id ${product.id} y quantity ${quantity.toString()}. No lo anotes sin su sí.`,
      };
    }

    const cart = (await this.get(key)) ?? emptyCart();
    if (this.isFull(cart, product.id)) {
      return TOO_MANY_ITEMS;
    }
    const next = setCartItem(
      cart,
      { product_id: product.id, name: product.name, unit_price: product.unit_price },
      quantity,
    );
    return {
      status: 'ok',
      cart: await this.save(key, next),
      note: `Pidió ${asked}: se anotaron ${how} = ${cop(total)}.`,
    };
  }

  /**
   * Presentaciones de la misma línea de producto que la elegida: su familia
   * (`parent_id`) y los productos sueltos con el mismo nombre base
   * ("PIMIENTA NEGRA MOLIDA …"), con su precio por defecto.
   */
  private async lineCandidates(
    companyId: number,
    chosen: SellableProduct,
  ): Promise<WeightCandidate[]> {
    const access = accessibleProductsPredicate('p', companyId, 1);
    const stem = productLineStem(chosen.name).toLowerCase();
    const params: unknown[] = [
      ...access.params,
      stem,
      `${stem} %`,
      String(chosen.parent_id ?? chosen.id),
    ];
    const n = access.params.length;
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT p.id
         FROM products p
        WHERE ${access.sql}
          AND ${SELLABLE_SQL}
          AND (
            ${accentInsensitiveLike('p.name', `$${n + 1}`)}
            OR ${accentInsensitiveLike('p.name', `$${n + 2}`)}
            OR COALESCE(p.parent_id, p.id) = $${n + 3}::bigint
          )
        ORDER BY p.id
        LIMIT ${MAX_LINE_CANDIDATES}`,
      params,
    );
    const ids = [...new Set([chosen.id, ...rows.map((row) => Number(row.id))])];
    const { sql, params: detailParams } = buildSellableDetailsSql(companyId, ids);
    const details = await this.dataSource.query<SellableDetailRow[]>(sql, detailParams);
    return details.map(toSellableProduct).flatMap((product) => {
      const unitPrice = defaultUnitPrice(product);
      return unitPrice
        ? [
            {
              id: product.id,
              name: product.name,
              unit_price: unitPrice,
              per_gram: isPerGramProduct(product),
              grams: presentationGrams(product),
            },
          ]
        : [];
    });
  }

  private isFull(cart: SellerCart, productId: number): boolean {
    const inCart = cart.items.some((item) => item.product_id === productId);
    return !inCart && cart.items.length >= MAX_CART_ITEMS;
  }

  /** Guarda datos de entrega (nombre, dirección, modo, pago, notas). */
  async setDetails(key: SessionKey, patch: Record<string, unknown>): Promise<SellerCart> {
    const cart = (await this.get(key)) ?? emptyCart();
    return this.save(key, mergeOrderDetails(cart, patch));
  }

  /**
   * Cierra el pedido: verifica que esté completo y que los precios sigan
   * vigentes, y lo devuelve para AVISARLE al dueño. Vacía el carrito (conserva
   * los datos de entrega para un próximo pedido) y deja la referencia.
   */
  async close(
    key: SessionKey,
    options: CartOptions,
    origin: CartOrigin,
  ): Promise<CloseOrderResult> {
    const cart = (await this.get(key)) ?? emptyCart();
    const missing = missingForCheckout(cart, options);
    if (missing.length > 0) {
      return { status: 'missing_data', cart, missing };
    }

    // Precios al día: si alguno cambió desde que se armó el carrito, se
    // actualiza y se le vuelve a mostrar el total al cliente antes de cerrar.
    const repriced = await this.reprice(key.companyId, cart);
    if (repriced.changed) {
      const saved = await this.save(key, repriced.cart);
      return {
        status: 'price_changed',
        cart: saved,
        message:
          'Algún precio o producto cambió desde que armaste el pedido. NO se cerró. Muéstrale al cliente el total actualizado y pide de nuevo su confirmación.',
      };
    }

    // Modificación de un pedido ya hecho: misma referencia.
    const reference = cart.amends?.reference ?? orderReference(cart.operation_id);
    const total = cartTotal(cart);
    const details = cart.details;
    const mode = resolveDeliveryMode(details, options);
    const order: ClosedOrder = {
      reference,
      items: cart.items.map((item) => ({
        name: item.name,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        line_total: Number(item.total),
      })),
      total: Number(total.toString()),
      customer_name: details.customer_name,
      customer_phone: details.customer_phone,
      delivery:
        mode === 'recoger'
          ? 'Recoge en el negocio'
          : `Domicilio${details.delivery_address ? `: ${details.delivery_address}` : ''}`,
      payment_method: details.payment_method,
      notes: details.notes,
      channel: origin.channel,
      chat_id: origin.chatId,
      chat_display_name: origin.chatDisplayName,
    };

    const record = buildAgentOrderRecord(
      cart,
      { ...options, reference },
      {
        // El canal de la conversación distingue WhatsApp por QR de Cloud API.
        channel: key.channel,
        chatId: origin.chatId,
        chatDisplayName: origin.chatDisplayName,
        channelAccount: origin.channelAccount,
        chatPhone: origin.chatPhone,
      },
    );

    // Bandeja del informe "Agente". Va ANTES de vaciar el carrito: si falla, el
    // carrito sigue intacto y el cierre se puede repetir (idempotente por
    // operation_id, no duplica). Si es una modificación, se actualiza el MISMO
    // pedido, y solo si nadie lo ha tomado.
    let orderId: string;
    if (cart.amends) {
      const amended = await this.orders.amendByCustomer(
        key.companyId,
        cart.amends.order_id,
        record,
      );
      if (amended === 'locked') {
        const view = await this.orders.findOne(key.companyId, Number(cart.amends.order_id));
        const released = await this.save(key, {
          ...cart,
          items: [],
          amends: undefined,
        });
        return { status: 'locked', cart: released, order: view };
      }
      orderId = cart.amends.order_id;
      order.kind = 'updated';
    } else {
      orderId = (await this.orders.record(key.companyId, record)).id;
    }

    const closed: SellerCart = {
      items: [],
      details,
      operation_id: randomUUID(),
      last_order: {
        reference,
        order_id: orderId || undefined,
        total: total.toFixed(2),
        placed_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    };
    const saved = await this.save(key, closed);
    this.logger.log(
      { companyId: key.companyId, channel: key.channel, reference, total: order.total },
      'Pedido cerrado por el vendedor (se avisa al dueño)',
    );
    return { status: 'closed', cart: saved, order };
  }

  /**
   * El cliente quiere CAMBIAR su último pedido: si sigue por tomar y sin ticket,
   * vuelve al carrito (con sus datos de entrega) marcado como modificación; al
   * confirmar, `close` actualiza ese mismo pedido. Si ya lo tomó una persona
   * (o se descartó), no se toca: `locked`.
   */
  async reopenLastOrder(key: SessionKey): Promise<ReopenOrderResult> {
    const cart = await this.get(key);
    const orderId = cart?.last_order?.order_id;
    if (!cart || !orderId) {
      return { status: 'none' };
    }
    if (cart.amends?.order_id === orderId) {
      return { status: 'reopened', cart };
    }
    if (cart.items.length > 0) {
      return { status: 'cart_busy' };
    }
    const view = await this.findOrder(key.companyId, orderId);
    if (!view) {
      return { status: 'none' };
    }
    if (!isOpenForCustomer(view)) {
      return { status: 'locked', order: view };
    }
    const reopened: SellerCart = {
      ...cart,
      items: view.items.map((item) => ({ ...item })),
      details: {
        ...cart.details,
        ...(view.customer_name ? { customer_name: view.customer_name } : {}),
        ...(view.customer_phone ? { customer_phone: view.customer_phone } : {}),
        delivery_mode: view.delivery_mode,
        ...(view.delivery_address ? { delivery_address: view.delivery_address } : {}),
        ...(view.payment_method ? { payment_method: view.payment_method } : {}),
        ...(view.notes ? { notes: view.notes } : {}),
      },
      amends: { order_id: orderId, reference: view.reference },
    };
    return { status: 'reopened', cart: await this.save(key, reopened) };
  }

  /**
   * El cliente CANCELA su último pedido: si sigue por tomar y sin ticket, queda
   * descartado por el cliente. Si ya lo tomó una persona, no se toca: `locked`.
   */
  async cancelLastOrder(key: SessionKey, reason: string | null): Promise<CancelOrderResult> {
    const cart = await this.get(key);
    const orderId = cart?.last_order?.order_id;
    if (!cart || !orderId) {
      return { status: 'none' };
    }
    const result = await this.orders.cancelByCustomer(key.companyId, orderId, reason);
    if (result === 'locked') {
      const view = await this.findOrder(key.companyId, orderId);
      return view ? { status: 'locked', order: view } : { status: 'none' };
    }
    // Si lo estaba modificando, se suelta: ya no hay nada que actualizar.
    const released = await this.save(key, {
      ...cart,
      items: cart.amends ? [] : cart.items,
      amends: undefined,
    });
    return { status: 'cancelled', reference: cart.last_order?.reference ?? '', cart: released };
  }

  /**
   * Deja anotada en el último pedido la solicitud del cliente (cambiar o
   * cancelar un pedido ya tomado) para que el equipo la atienda.
   */
  async requestOnLastOrder(key: SessionKey, request: string): Promise<AgentOrderView | null> {
    const orderId = (await this.get(key))?.last_order?.order_id;
    if (!orderId) {
      return null;
    }
    await this.orders.recordCustomerRequest(key.companyId, orderId, request);
    return this.findOrder(key.companyId, orderId);
  }

  private async findOrder(companyId: number, orderId: string): Promise<AgentOrderView | null> {
    try {
      return await this.orders.findOne(companyId, Number(orderId));
    } catch {
      return null;
    }
  }

  private async reprice(
    companyId: number,
    cart: SellerCart,
  ): Promise<{ changed: boolean; cart: SellerCart }> {
    let changed = false;
    let next: SellerCart = cart;
    for (const item of cart.items) {
      const product = await this.fetchProduct(companyId, item.product_id);
      const priced = product
        ? priceLine({
            product,
            quantity: new Big(item.quantity),
            price_level: null,
            manual_price: null,
            note: null,
            minimum_margin: null,
          })
        : null;
      if (!product || !priced || priced.status !== 'ok') {
        changed = true;
        next = setCartItem(
          next,
          { product_id: item.product_id, name: item.name, unit_price: new Big(0) },
          new Big(0),
        );
        continue;
      }
      if (priced.line.unit_price !== item.unit_price) {
        changed = true;
        next = setCartItem(
          next,
          {
            product_id: product.id,
            name: product.name,
            unit_price: new Big(priced.line.unit_price),
          },
          new Big(item.quantity),
        );
      }
    }
    return { changed, cart: next };
  }

  private async fetchProduct(
    companyId: number,
    productId: number,
  ): Promise<SellableProduct | null> {
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return null;
    }
    const { sql, params } = buildSellableDetailsSql(companyId, [productId]);
    const rows = await this.dataSource.query<SellableDetailRow[]>(sql, params);
    return rows[0] ? toSellableProduct(rows[0]) : null;
  }

  private find(key: SessionKey): Promise<SalesBotConversationEntity | null> {
    return this.repo.findOne({ where: where(key) });
  }

  /** Persiste SOLO la columna `cart` (no pisa turnos ni día de la memoria). */
  private async save(key: SessionKey, cart: SellerCart): Promise<SellerCart> {
    const stamped: SellerCart = { ...cart, updated_at: new Date().toISOString() };
    const row = await this.find(key);
    if (row) {
      await this.repo.update({ id: row.id }, { cart: stamped });
    } else {
      await this.repo.save(
        this.repo.create({
          ...where(key),
          turns: [],
          order_signatures: [],
          last_day: null,
          cart: stamped,
        }),
      );
    }
    return stamped;
  }
}

const where = (key: SessionKey) => ({
  company_id: String(key.companyId),
  channel: key.channel,
  chat_id: key.chatId,
});

/** El cliente aún puede cambiar o cancelar: por tomar y sin ticket vivo. */
export const isOpenForCustomer = (order: AgentOrderView): boolean =>
  order.status === 'pending' && (!order.ticket || order.ticket.is_voided);
