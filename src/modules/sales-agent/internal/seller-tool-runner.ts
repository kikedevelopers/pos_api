import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import Big from 'big.js';

import { toBig } from '@/common/utils/precision';
import { accentInsensitiveLike } from '@/modules/ai/internal/tool-sql';
import type { GeminiFunctionCall } from '@/modules/ai/internal/gemini.types';
import { accessibleProductsPredicate } from '@/modules/products/internal/accessible-products.helper';

import type { SalesBotStockPolicy } from '../entities/sales-bot-settings.entity';
import { CatalogSemanticService } from '@/modules/catalog-knowledge/catalog-semantic.service';

import { SellerCartService, type CartOptions } from '../seller-cart.service';
import { cartView, isDeliveryModeOffered } from './cart';
import { formatCancelledNotice, formatTakenRequestNotice } from './order-format';
import type { AgentOrderView } from '../sales-agent-orders.service';
import { SELLABLE_SQL } from './sellable-sql';
import type { SessionKey } from './session-store';
import type { ClosedOrder } from './types';

/** Datos del canal para etiquetar el pedido cerrado (quién y por dónde escribe). */
export interface SellerToolContext {
  companyId: number;
  channel: string;
  /**
   * Conversación (memoria + carrito). Sin ella, las herramientas del carrito
   * no están disponibles.
   */
  conversation?: SessionKey;
  /** El negocio deja recoger en su punto. Default: false. */
  pickupAvailable?: boolean;
  /** El negocio hace domicilios. Default: true. */
  deliveryAvailable?: boolean;
  chatId: string;
  chatDisplayName?: string;
  /** Cuenta del negocio en el canal (`@usuario_bot`, número de WhatsApp). */
  channelAccount?: string;
  /** Número del cliente cuando el canal lo da aparte (WhatsApp con chat `@lid`). */
  chatPhone?: string;
  /**
   * Política de stock del negocio. Con `offer_always` las herramientas NO le
   * entregan el stock al modelo (no puede mencionarlo) y "populares" incluye
   * productos sin existencias. Default: `inform`.
   */
  stockPolicy?: SalesBotStockPolicy;
}

const FAMILIES_NOTE =
  'Cada elemento de "families" es UN producto con TODAS sus presentaciones (libra, media libra, cuarto, paquete, gramo, caja...). Si el cliente no dijo la presentación, ofrécele las de consumo con su precio y pregúntale cuál prefiere; no escojas una sola. Habla de los productos con naturalidad (no copies el nombre del catálogo en mayúsculas ni con abreviaturas); para agregar al pedido usa el "id" de la presentación en set_cart_item.';

const SEARCH_NOTE_INFORM =
  FAMILIES_NOTE +
  ' Precios en pesos (COP). El PRIMER precio de "prices" es el precio por defecto: cotiza SIEMPRE con ese, salvo que el cliente pida otro nivel (p. ej. mayorista). Si te preguntan el precio de un producto, DALO siempre aunque "stock" sea 0 o negativo; la disponibilidad se aclara aparte (no ofrezcas como disponible lo que no hay). "stock" está en la unidad de cada presentación. Nunca menciones costos ni márgenes.';

const SEARCH_NOTE_OFFER_ALWAYS =
  FAMILIES_NOTE +
  ' Precios en pesos (COP). El PRIMER precio de "prices" es el precio por defecto: cotiza SIEMPRE con ese, salvo que el cliente pida otro nivel (p. ej. mayorista). Todos los productos se ofrecen y se venden con normalidad: la disponibilidad la gestiona el negocio, así que NO hables de existencias ni de stock. Nunca menciones costos ni márgenes.';

const POPULAR_NOTE_INFORM =
  'Sugerencias ordenadas por lo más vendido en los últimos 90 días, solo con stock disponible. Úsalas para recomendar o hacer venta cruzada. Precios en pesos (COP).';

const POPULAR_NOTE_OFFER_ALWAYS =
  'Sugerencias ordenadas por lo más vendido en los últimos 90 días. Úsalas para recomendar o hacer venta cruzada. No hables de existencias. Precios en pesos (COP).';

const CART_UNAVAILABLE = {
  status: 'unavailable',
  message:
    'El pedido no está disponible en este momento. Toma los datos y dile que el negocio lo confirma.',
};

const CART_UPDATED_MESSAGE =
  'Pedido actualizado. ANTES de responder, revisa línea por línea que cada producto, presentación y cantidad sea EXACTAMENTE lo que pidió el cliente (ni más ni menos, ni otra presentación); si algo no cuadra, corrígelo con set_cart_item. Al contarle al cliente lo que anotaste, usa las cantidades y los totales de este pedido TAL CUAL (no los recalcules ni los tomes de la búsqueda). Revisa "missing_to_close" y avanza UN paso hacia el cierre.';

const cartOptions = (context: SellerToolContext): CartOptions => ({
  pickupAvailable: context.pickupAvailable === true,
  deliveryAvailable: context.deliveryAvailable !== false,
});

/** Resultado de ejecutar una herramienta: respuesta para el modelo + efecto. */
export interface SellerToolResult {
  /** Objeto que se le devuelve al modelo como functionResponse. */
  response: Record<string, unknown>;
  /** Pedido cerrado (solo lo pone close_order); el canal avisa al dueño. */
  order?: ClosedOrder;
  /** Aviso de texto para el negocio (cancelación, solicitud sobre un pedido tomado). */
  notice?: string;
}

const num = (value: string | number | null | undefined): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
};

const toPositiveInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), min), max);
};

/** Filas de inventario que leen las herramientas (sin costos). */
interface InventoryRow {
  id: string;
  family_id: string;
  family_name: string;
  name: string;
  sku_code: string | null;
  bar_code: string | null;
  parent_id: string | null;
  stock: string;
  parent_stock: string | null;
  category: string | null;
  packaging: string | null;
  packaging_value: string | null;
  prices: Array<{ name: string; sale_price: string }> | null;
  /** Ficha "Para el asistente" del producto base (solo en búsquedas por familia). */
  family_profile?: {
    description?: string;
    uses?: string[];
    attributes?: Array<{ name: string; value: string }>;
    related?: Array<{ id: string | number; name: string; kind: string }>;
  } | null;
}

/** Máximo de filas (presentaciones) que devuelve una búsqueda. */
const MAX_SEARCH_ROWS = 60;

export { SELLABLE_SQL } from './sellable-sql';

/**
 * Hay existencias del producto: las presentaciones (`parent_id`) consumen del
 * stock del base, así que se mira el del padre.
 */
export const IN_STOCK_SQL = 'COALESCE(parent.stock, p.stock) > 0';

/**
 * Existencias en la unidad del producto, como las ve el usuario en Inventario:
 * el stock (en unidad mínima) ÷ el factor de empaque. Las presentaciones leen el
 * stock del base (su fila trae 0). Misma fórmula que `availableUnits` del
 * asistente del dueño. Se redondea hacia abajo: nunca se promete de más.
 */
export const availableStock = (
  row: Pick<InventoryRow, 'parent_id' | 'stock' | 'parent_stock' | 'packaging_value'>,
): number => {
  const source = row.parent_id !== null && row.parent_stock !== null ? row.parent_stock : row.stock;
  const stock = toBig(source ?? 0);
  const factor = row.packaging_value !== null ? toBig(row.packaging_value) : null;
  const units = factor !== null && factor.gt(0) ? stock.div(factor) : stock;
  return Number(units.round(2, Big.roundDown).toString());
};

const mapPrices = (prices: InventoryRow['prices']): Array<{ name: string; salePrice: number }> =>
  (prices ?? []).map((price) => ({ name: price.name, salePrice: num(price.sale_price) }));

const NEED_NOTE =
  'Resultados por PARECIDO con la necesidad, del más al menos parecido. Usa la ficha ("profile": descripción, para qué sirve, características) para elegir el que de verdad la resuelve y explica en una frase por qué; si el cliente agrega un requisito (p. ej. "también para las papas"), compara las características y ofrece el que lo cumple (mira también los relacionados de tipo "upgrade").';

/**
 * Consulta de familias: toma el CTE `matched` (family_id + rank) y trae cada
 * familia completa (base + presentaciones vendibles) con precios, stock y la
 * ficha "Para el asistente" del producto base. El orden respeta `rank`.
 */
export const familiesSql = (accessSql: string, matchedCte: string, rowLimitIdx: string): string => `
      WITH matched AS (${matchedCte}
      )
      SELECT
        COALESCE(p.parent_id, p.id) AS family_id,
        fam.name AS family_name,
        p.id,
        p.name,
        p.sku_code,
        p.bar_code,
        p.parent_id,
        p.stock,
        parent.stock AS parent_stock,
        cat.name AS category,
        pk.name  AS packaging,
        pk.value AS packaging_value,
        (
          SELECT jsonb_agg(jsonb_build_object('name', pp.name, 'sale_price', pp.sale_price)
                 ORDER BY pp.id ASC)
          FROM product_prices pp
          WHERE pp.product_id = p.id
        ) AS prices,
        (
          SELECT jsonb_build_object(
                   'description', pap.description,
                   'uses', pap.uses,
                   'attributes', pap.attributes,
                   'related', (
                     SELECT COALESCE(jsonb_agg(jsonb_build_object(
                              'id', r.id, 'name', r.name, 'kind', x.value->>'kind')), '[]'::jsonb)
                       FROM jsonb_array_elements(pap.related) AS x
                       JOIN products r ON r.id = (x.value->>'product_id')::bigint
                                      AND r.is_archived = false
                   )
                 )
            FROM product_assistant_profiles pap
           WHERE pap.product_id = m.family_id
        ) AS family_profile
      FROM products p
      JOIN matched m ON m.family_id = COALESCE(p.parent_id, p.id)
      JOIN products fam ON fam.id = m.family_id
      LEFT JOIN products parent ON parent.id = p.parent_id
      LEFT JOIN categories cat ON cat.id = p.category_id
      LEFT JOIN packagings pk ON pk.id = p.packaging_id
      WHERE ${accessSql}
        AND ${SELLABLE_SQL}
      ORDER BY m.rank ASC, (p.parent_id IS NOT NULL) ASC, pk.value DESC NULLS LAST, p.name ASC
      LIMIT ${rowLimitIdx}
      `;

/** Ficha compacta para el modelo (sin campos vacíos); `null` si no aporta nada. */
export const compactProfile = (
  raw: InventoryRow['family_profile'],
): Record<string, unknown> | null => {
  if (!raw) {
    return null;
  }
  const profile: Record<string, unknown> = {};
  if (typeof raw.description === 'string' && raw.description.trim()) {
    profile.description = raw.description.trim();
  }
  if (Array.isArray(raw.uses) && raw.uses.length > 0) {
    profile.uses = raw.uses;
  }
  if (Array.isArray(raw.attributes) && raw.attributes.length > 0) {
    profile.attributes = raw.attributes;
  }
  if (Array.isArray(raw.related) && raw.related.length > 0) {
    profile.related = raw.related.map((r) => ({ id: Number(r.id), name: r.name, kind: r.kind }));
  }
  return Object.keys(profile).length > 0 ? profile : null;
};

/** Agrupa las filas por familia (producto base + sus presentaciones). */
export const groupFamilies = (
  rows: readonly InventoryRow[],
  hideStock: boolean,
): Array<Record<string, unknown>> => {
  const families = new Map<
    string,
    {
      product: string;
      profile?: Record<string, unknown>;
      presentations: Array<Record<string, unknown>>;
    }
  >();
  for (const row of rows) {
    const familyId = String(row.family_id);
    const profile = compactProfile(row.family_profile);
    const family = families.get(familyId) ?? {
      product: row.family_name,
      ...(profile ? { profile } : {}),
      presentations: [],
    };
    family.presentations.push({
      id: Number(row.id),
      name: row.name,
      sku: row.sku_code,
      barcode: row.bar_code,
      category: row.category,
      packaging: row.packaging,
      ...(hideStock ? {} : { stock: availableStock(row) }),
      prices: mapPrices(row.prices),
    });
    families.set(familyId, family);
  }
  return [...families.values()];
};

/** ¿El negocio pide ofrecer sin hablar de stock? */
const offerAlways = (context: SellerToolContext): boolean => context.stockPolicy === 'offer_always';

/** Ventana para "populares": unidades vendidas en los últimos N días. */
const POPULAR_WINDOW_DAYS = 90;

/**
 * Ejecuta las herramientas del vendedor contra la base del negocio. Todo queda
 * acotado a `company_id`. El inventario NUNCA expone costo ni margen: el vendedor
 * no ve esa información.
 */
@Injectable()
export class SellerToolRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cart: SellerCartService,
    private readonly semantic: CatalogSemanticService,
  ) {}

  async execute(call: GeminiFunctionCall, context: SellerToolContext): Promise<SellerToolResult> {
    const args = call.args ?? {};
    switch (call.name) {
      case 'search_products':
        return {
          response: await this.searchProducts(context.companyId, args, offerAlways(context)),
        };
      case 'find_products_for_need':
        return {
          response: await this.findProductsForNeed(context.companyId, args, offerAlways(context)),
        };
      case 'get_popular_products':
        return {
          response: await this.popularProducts(context.companyId, args, offerAlways(context)),
        };
      case 'set_cart_item':
        return { response: await this.setCartItem(args, context) };
      case 'set_order_details':
        return { response: await this.setOrderDetails(args, context) };
      case 'close_order':
        return this.closeOrder(context);
      case 'modify_last_order':
        return this.modifyLastOrder(args, context);
      case 'cancel_last_order':
        return this.cancelLastOrder(args, context);
      default:
        return { response: { error: `Herramienta no disponible: ${call.name}` } };
    }
  }

  /**
   * Inventario por nombre/código: existencias y PRECIOS de venta, sin costos.
   * Agrupa cada producto con TODAS sus presentaciones (base + hijos), aunque la
   * búsqueda solo haya coincidido con una: así el vendedor puede ofrecer libra,
   * media libra y cuarto en vez de escoger una sola.
   */
  private async searchProducts(
    companyId: number,
    args: Record<string, unknown>,
    hideStock: boolean,
  ): Promise<Record<string, unknown>> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return { error: 'Falta el texto de búsqueda.' };
    }
    const familyLimit = toPositiveInt(args.limit, 8, 1, 15);

    const access = accessibleProductsPredicate('p', companyId, 1);
    const params: unknown[] = [
      ...access.params,
      `%${query.toLowerCase()}%`,
      familyLimit,
      MAX_SEARCH_ROWS,
      `${query.toLowerCase()}%`,
    ];
    const searchIdx = `$${access.params.length + 1}`;
    const familyLimitIdx = `$${access.params.length + 2}`;
    const rowLimitIdx = `$${access.params.length + 3}`;
    const prefixIdx = `$${access.params.length + 4}`;
    // Primero los que EMPIEZAN por lo buscado, luego los que lo contienen en el
    // nombre y al final los que solo coinciden por categoría o alias.
    const relevance = [
      `BOOL_OR(${accentInsensitiveLike('p.name', prefixIdx)}) DESC`,
      `BOOL_OR(${accentInsensitiveLike('p.name', searchIdx)}) DESC`,
      'MIN(p.name) ASC',
    ].join(', ');

    const matched = `
        SELECT
          COALESCE(p.parent_id, p.id) AS family_id,
          ROW_NUMBER() OVER (ORDER BY ${relevance}) AS rank
        FROM products p
        WHERE ${access.sql}
          AND ${SELLABLE_SQL}
          AND (
            ${accentInsensitiveLike('p.name', searchIdx)}
            OR ${accentInsensitiveLike("COALESCE(p.sku_code, '')", searchIdx)}
            OR ${accentInsensitiveLike("COALESCE(p.bar_code, '')", searchIdx)}
            -- La categoría ("productos venezolanos", "lácteos"): el cliente
            -- suele preguntar por la línea, no por el producto.
            OR EXISTS (
              SELECT 1 FROM categories cat
               WHERE cat.id = p.category_id
                 AND ${accentInsensitiveLike('cat.name', searchIdx)}
            )
            -- Cómo lo llaman los clientes (ficha "Para el asistente").
            OR EXISTS (
              SELECT 1 FROM product_assistant_profiles pap
               WHERE pap.product_id = COALESCE(p.parent_id, p.id)
                 AND ${accentInsensitiveLike('pap.aliases::text', searchIdx)}
            )
          )
        GROUP BY COALESCE(p.parent_id, p.id)
        ORDER BY ${relevance}
        LIMIT ${familyLimitIdx}`;
    const rows = await this.dataSource.query<InventoryRow[]>(
      familiesSql(access.sql, matched, rowLimitIdx),
      params,
    );

    const families = groupFamilies(rows, hideStock);
    return {
      query,
      count: families.length,
      currency: 'COP',
      families,
      note: hideStock ? SEARCH_NOTE_OFFER_ALWAYS : SEARCH_NOTE_INFORM,
    };
  }

  /**
   * Búsqueda por NECESIDAD ("algo para hamburguesa y papas"): la búsqueda por
   * significado elige las familias y aquí se arman igual que en search_products
   * (presentaciones, precios, stock y ficha), en orden de parecido.
   */
  private async findProductsForNeed(
    companyId: number,
    args: Record<string, unknown>,
    hideStock: boolean,
  ): Promise<Record<string, unknown>> {
    const need = typeof args.need === 'string' ? args.need.trim() : '';
    if (!need) {
      return { error: 'Falta describir la necesidad del cliente.' };
    }
    const limit = toPositiveInt(args.limit, 5, 1, 10);
    const matches = await this.semantic.search(companyId, need, limit);
    if (matches.length === 0) {
      return {
        need,
        count: 0,
        families: [],
        note: 'No encontré productos que respondan a esa necesidad. Prueba search_products con palabras concretas o pregúntale al cliente un detalle más; no inventes productos.',
      };
    }

    const access = accessibleProductsPredicate('p', companyId, 1);
    const params: unknown[] = [...access.params, matches.map((m) => String(m.id)), MAX_SEARCH_ROWS];
    const idsIdx = `$${access.params.length + 1}`;
    const rowLimitIdx = `$${access.params.length + 2}`;
    const matched = `
        SELECT x.id::bigint AS family_id, x.rank
          FROM unnest(${idsIdx}::bigint[]) WITH ORDINALITY AS x(id, rank)`;
    const rows = await this.dataSource.query<InventoryRow[]>(
      familiesSql(access.sql, matched, rowLimitIdx),
      params,
    );
    const families = groupFamilies(rows, hideStock);
    return {
      need,
      count: families.length,
      currency: 'COP',
      families,
      note: `${NEED_NOTE} ${hideStock ? SEARCH_NOTE_OFFER_ALWAYS : SEARCH_NOTE_INFORM}`,
    };
  }

  /** Productos más vendidos (últimos 90 días) con stock y precio, para recomendar. */
  private async popularProducts(
    companyId: number,
    args: Record<string, unknown>,
    hideStock: boolean,
  ): Promise<Record<string, unknown>> {
    const limit = toPositiveInt(args.limit, 8, 1, 15);

    // $1 = company, $2 = días de ventana; el predicado de acceso va desde $3.
    const access = accessibleProductsPredicate('p', companyId, 3);
    const params: unknown[] = [companyId, POPULAR_WINDOW_DAYS, ...access.params, limit];
    const limitIdx = `$${params.length}`;

    const rows = await this.dataSource.query<
      Array<
        Pick<
          InventoryRow,
          | 'id'
          | 'name'
          | 'stock'
          | 'parent_id'
          | 'parent_stock'
          | 'category'
          | 'packaging'
          | 'packaging_value'
          | 'prices'
        > & { units: string | null }
      >
    >(
      `
      SELECT
        p.id,
        p.name,
        p.stock,
        p.parent_id,
        parent.stock AS parent_stock,
        cat.name AS category,
        pk.name  AS packaging,
        pk.value AS packaging_value,
        COALESCE(sold.units, 0) AS units,
        (
          SELECT jsonb_agg(jsonb_build_object('name', pp.name, 'sale_price', pp.sale_price)
                 ORDER BY pp.id ASC)
          FROM product_prices pp
          WHERE pp.product_id = p.id
        ) AS prices
      FROM products p
      LEFT JOIN products parent ON parent.id = p.parent_id
      LEFT JOIN categories cat ON cat.id = p.category_id
      LEFT JOIN packagings pk ON pk.id = p.packaging_id
      LEFT JOIN (
        SELECT l.product_id, SUM(l.quantity) AS units
        FROM sale_invoice_lines l
        JOIN sale_invoices s ON s.id = l.sale_invoice_id
        WHERE l.company_id = $1::bigint
          AND s.is_deleted = false
          AND COALESCE(s.sold_at, s.created_at) >= (NOW() - ($2 || ' days')::interval)
        GROUP BY l.product_id
      ) AS sold ON sold.product_id = p.id
      WHERE ${access.sql}
        AND ${SELLABLE_SQL}
        ${hideStock ? '' : `AND ${IN_STOCK_SQL}`}
      ORDER BY COALESCE(sold.units, 0) DESC, p.name ASC
      LIMIT ${limitIdx}
      `,
      params,
    );

    return {
      count: rows.length,
      currency: 'COP',
      products: rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        category: row.category,
        packaging: row.packaging,
        ...(hideStock ? {} : { stock: availableStock(row) }),
        unitsSoldRecently: num(row.units),
        prices: mapPrices(row.prices),
      })),
      note: hideStock ? POPULAR_NOTE_OFFER_ALWAYS : POPULAR_NOTE_INFORM,
    };
  }

  /** Pone la cantidad de una presentación en el pedido (0 = quitarla). */
  private async setCartItem(
    args: Record<string, unknown>,
    context: SellerToolContext,
  ): Promise<Record<string, unknown>> {
    if (!context.conversation) {
      return CART_UNAVAILABLE;
    }
    const productId = Number(args.product_id);
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return {
        status: 'invalid_product',
        message:
          'Falta el "id" de la presentación (lo da search_products). NO se cambió el pedido.',
      };
    }
    const result = await this.cart.setItem(
      context.conversation,
      productId,
      args.quantity,
      args.amount_requested,
    );
    if (result.status !== 'ok') {
      return { status: result.status, message: result.message };
    }
    return {
      status: 'ok',
      cart: cartView(result.cart, cartOptions(context)),
      message: result.note ? `${result.note} ${CART_UPDATED_MESSAGE}` : CART_UPDATED_MESSAGE,
    };
  }

  /** Guarda datos de entrega que dio el cliente. */
  private async setOrderDetails(
    args: Record<string, unknown>,
    context: SellerToolContext,
  ): Promise<Record<string, unknown>> {
    if (!context.conversation) {
      return CART_UNAVAILABLE;
    }
    // Una entrega que el negocio no ofrece no se guarda: el agente no puede
    // prometer domicilio (ni recogida) por su cuenta.
    const mode =
      typeof args.delivery_mode === 'string' ? args.delivery_mode.trim().toLowerCase() : '';
    if (
      (mode === 'domicilio' || mode === 'recoger') &&
      !isDeliveryModeOffered(mode, cartOptions(context))
    ) {
      return {
        status: 'delivery_not_offered',
        message:
          mode === 'domicilio'
            ? 'NO se guardó: el negocio NO hace envíos a domicilio. Díselo al cliente con amabilidad y que el pedido se recoge en el negocio. Nunca le pidas dirección de entrega.'
            : 'NO se guardó: el negocio NO tiene recogida en punto físico; los pedidos son a domicilio. Pídele la dirección de entrega.',
      };
    }
    const cart = await this.cart.setDetails(context.conversation, args);
    return { status: 'ok', cart: cartView(cart, cartOptions(context)) };
  }

  /** Cierra el pedido confirmado: el canal le AVISA al dueño (no se crea venta). */
  private async closeOrder(context: SellerToolContext): Promise<SellerToolResult> {
    if (!context.conversation) {
      return { response: CART_UNAVAILABLE };
    }
    const result = await this.cart.close(context.conversation, cartOptions(context), {
      channel: context.channel,
      chatId: context.chatId,
      chatDisplayName: context.chatDisplayName,
      channelAccount: context.channelAccount,
      chatPhone: context.chatPhone,
    });
    if (result.status === 'missing_data') {
      return {
        response: {
          status: 'missing_data',
          missing: result.missing,
          message: `NO se cerró: falta ${result.missing.join(', ')}. Pídeselo al cliente de forma natural, una cosa a la vez.`,
        },
      };
    }
    if (result.status === 'price_changed') {
      return {
        response: {
          status: 'price_changed',
          cart: cartView(result.cart, cartOptions(context)),
          message: result.message,
        },
      };
    }
    if (result.status === 'locked') {
      // Mientras el cliente confirmaba, una persona tomó el pedido: no se tocó.
      return this.takenResponse(context, result.order, 'change', 'cambios que pidió en este chat');
    }
    const updated = result.order.kind === 'updated';
    return {
      order: result.order,
      response: {
        status: updated ? 'updated' : 'closed',
        reference: result.order.reference,
        total: result.order.total,
        message: updated
          ? 'Pedido ACTUALIZADO (misma referencia) y enviado al negocio. Confírmale al cliente en una o dos frases que su pedido quedó actualizado, con la referencia y el nuevo total. NO digas que es un pedido nuevo. No vuelvas a llamar close_order para este pedido.'
          : 'Pedido TOMADO y enviado al negocio. Confírmale al cliente en una o dos frases (referencia y total, sin repetir toda la lista) y dile que el negocio le confirma en un momento la entrega y el pago. NO digas que quedó "registrado en el sistema" ni facturado. No vuelvas a llamar close_order para este pedido.',
      },
    };
  }

  /** El cliente quiere cambiar el pedido que ya hizo. */
  private async modifyLastOrder(
    args: Record<string, unknown>,
    context: SellerToolContext,
  ): Promise<SellerToolResult> {
    if (!context.conversation) {
      return { response: CART_UNAVAILABLE };
    }
    const request = readText(args.request);
    const result = await this.cart.reopenLastOrder(context.conversation);
    if (result.status === 'none') {
      return {
        response: {
          status: 'no_order',
          message:
            'No hay un pedido anterior de este cliente que se pueda cambiar en esta conversación. Si quiere comprar, arma un pedido nuevo.',
        },
      };
    }
    if (result.status === 'cart_busy') {
      return {
        response: {
          status: 'cart_busy',
          message:
            'Hay un pedido NUEVO en curso en el carrito. Pregúntale si lo que pide es para ese pedido nuevo o para cambiar el anterior; si es para el anterior, primero vacía el carrito (set_cart_item con 0).',
        },
      };
    }
    if (result.status === 'locked') {
      return this.takenResponse(context, result.order, 'change', request);
    }
    return {
      response: {
        status: 'reopened',
        cart: cartView(result.cart, cartOptions(context)),
        message: `El pedido ${result.cart.amends?.reference ?? ''} volvió al carrito para MODIFICARLO (aún nadie lo ha tomado). Aplica con set_cart_item / set_order_details lo que pidió cambiar, muéstrale el resumen y, con su "sí", close_order lo ACTUALIZA con la misma referencia (no crea uno nuevo).`,
      },
    };
  }

  /** El cliente quiere cancelar el pedido que ya hizo. */
  private async cancelLastOrder(
    args: Record<string, unknown>,
    context: SellerToolContext,
  ): Promise<SellerToolResult> {
    if (!context.conversation) {
      return { response: CART_UNAVAILABLE };
    }
    const reason = readText(args.reason);
    const result = await this.cart.cancelLastOrder(context.conversation, reason || null);
    if (result.status === 'none') {
      return {
        response: {
          status: 'no_order',
          message: 'No hay un pedido anterior de este cliente para cancelar en esta conversación.',
        },
      };
    }
    if (result.status === 'locked') {
      return this.takenResponse(context, result.order, 'cancel', reason);
    }
    return {
      notice: formatCancelledNotice(result.reference, reason || null),
      response: {
        status: 'cancelled',
        reference: result.reference,
        message: `Pedido ${result.reference} CANCELADO (nadie lo había tomado). Confírmale al cliente con amabilidad que quedó cancelado y déjale la puerta abierta para cuando quiera.`,
      },
    };
  }

  /**
   * El pedido ya no se puede tocar (lo tomó una persona o se descartó): queda
   * la solicitud para el equipo, se le avisa al negocio y el agente se lo
   * explica al cliente.
   */
  private async takenResponse(
    context: SellerToolContext,
    order: AgentOrderView,
    kind: 'change' | 'cancel',
    request: string,
  ): Promise<SellerToolResult> {
    if (order.status === 'dismissed') {
      return {
        response: {
          status: 'already_dismissed',
          reference: order.reference,
          message: order.cancelled_by_customer
            ? `El pedido ${order.reference} ya estaba cancelado. Si quiere comprar, arma un pedido NUEVO.`
            : `El pedido ${order.reference} no siguió adelante en el negocio. Dile con amabilidad que el negocio lo contactará, y si quiere comprar, arma un pedido NUEVO.`,
        },
      };
    }
    const label =
      kind === 'cancel'
        ? `Cancelar el pedido${request ? `: ${request}` : ''}`
        : `Cambiar el pedido${request ? `: ${request}` : ''}`;
    if (context.conversation) {
      await this.cart.requestOnLastOrder(context.conversation, label);
    }
    return {
      notice: formatTakenRequestNotice(order, kind, request),
      response: {
        status: 'already_taken',
        reference: order.reference,
        message: `NO se cambió: el pedido ${order.reference} ya lo tomó el equipo y se está alistando (o ya está alistado). Dile al cliente, con calidez, que su pedido ya está en preparación y que pasaste su solicitud al equipo de despacho, que lo contactará en breve para ${kind === 'cancel' ? 'la cancelación' : 'el cambio'}. NO prometas que se hará el cambio ni armes un pedido nuevo para reemplazarlo.`,
      },
    };
  }
}

/** Texto libre del modelo, en una línea y acotado. */
const readText = (raw: unknown): string =>
  typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
