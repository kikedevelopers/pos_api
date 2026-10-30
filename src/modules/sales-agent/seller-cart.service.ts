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

import { SalesBotConversationEntity } from './entities/sales-bot-conversation.entity';
import {
  MAX_CART_ITEMS,
  cartTotal,
  emptyCart,
  isCartExpired,
  mergeOrderDetails,
  missingForCheckout,
  orderReference,
  readCartQuantity,
  setCartItem,
  type SellerCart,
} from './internal/cart';
import type { SessionKey } from './internal/session-store';
import type { ClosedOrder } from './internal/types';

/** Opciones del negocio que afectan el cierre. */
export interface CartOptions {
  /** El negocio tiene punto físico (dirección): se puede recoger. */
  pickupAvailable: boolean;
}

/** De dónde viene el pedido (para el aviso al dueño). */
export interface CartOrigin {
  channel: string;
  chatId: string;
  chatDisplayName?: string;
}

export type SetItemResult =
  | { status: 'ok'; cart: SellerCart }
  | { status: 'invalid_quantity' | 'not_found' | 'no_price' | 'too_many_items'; message: string };

export type CloseOrderResult =
  | { status: 'closed'; cart: SellerCart; order: ClosedOrder }
  | { status: 'missing_data'; cart: SellerCart; missing: string[] }
  | { status: 'price_changed'; cart: SellerCart; message: string };

/**
 * Carrito del vendedor por conversación (columna `cart` de
 * `sales_bot_conversations`). El servidor pone los precios (nivel por defecto
 * del producto, la misma regla del POS), así el total que ve el cliente es real.
 *
 * Cerrar NO crea venta ni pedido en el POS: devuelve el pedido para que el canal
 * le AVISE al dueño.
 */
@Injectable()
export class SellerCartService {
  private readonly logger = new Logger(SellerCartService.name);

  constructor(
    @InjectRepository(SalesBotConversationEntity)
    private readonly repo: Repository<SalesBotConversationEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** Carrito vigente de la conversación (`null` si no hay o venció). */
  async get(key: SessionKey): Promise<SellerCart | null> {
    const row = await this.find(key);
    return row?.cart && !isCartExpired(row.cart) ? row.cart : null;
  }

  /** Pone la cantidad de un producto (0 = quitarlo), con el precio del servidor. */
  async setItem(key: SessionKey, productId: number, rawQuantity: unknown): Promise<SetItemResult> {
    const quantity = readCartQuantity(rawQuantity);
    if (quantity === null) {
      return {
        status: 'invalid_quantity',
        message: 'Cantidad no válida. Usa un número mayor o igual a 0 (0 = quitar del carrito).',
      };
    }

    const cart = (await this.get(key)) ?? emptyCart();
    const inCart = cart.items.some((item) => item.product_id === productId);

    if (quantity.eq(0)) {
      return {
        status: 'ok',
        cart: await this.save(
          key,
          setCartItem(cart, { product_id: productId, name: '', unit_price: new Big(0) }, quantity),
        ),
      };
    }
    if (!inCart && cart.items.length >= MAX_CART_ITEMS) {
      return {
        status: 'too_many_items',
        message: `El carrito ya tiene ${MAX_CART_ITEMS} productos distintos; cierra este pedido antes de agregar más.`,
      };
    }

    const product = await this.fetchProduct(key.companyId, productId);
    if (!product) {
      return {
        status: 'not_found',
        message:
          'Ese producto no está disponible para la venta. Búscalo de nuevo con search_products y usa el "id" de la presentación.',
      };
    }
    const priced = priceLine({
      product,
      quantity,
      price_level: null,
      manual_price: null,
      note: null,
      minimum_margin: null,
    });
    if (priced.status !== 'ok') {
      return {
        status: 'no_price',
        message: `${product.name} no tiene precio de venta configurado; no lo ofrezcas.`,
      };
    }

    const next = setCartItem(
      cart,
      { product_id: product.id, name: product.name, unit_price: new Big(priced.line.unit_price) },
      quantity,
    );
    return { status: 'ok', cart: await this.save(key, next) };
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

    const reference = orderReference(cart.operation_id);
    const total = cartTotal(cart);
    const details = cart.details;
    const mode = options.pickupAvailable ? details.delivery_mode : 'domicilio';
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

    const closed: SellerCart = {
      items: [],
      details,
      operation_id: randomUUID(),
      last_order: { reference, total: total.toFixed(2), placed_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    };
    const saved = await this.save(key, closed);
    this.logger.log(
      { companyId: key.companyId, channel: key.channel, reference, total: order.total },
      'Pedido cerrado por el vendedor (se avisa al dueño)',
    );
    return { status: 'closed', cart: saved, order };
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
