import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import Big from 'big.js';

import { toBig } from '@/common/utils/precision';
import { accentInsensitiveLike } from '@/modules/ai/internal/tool-sql';
import type { GeminiFunctionCall } from '@/modules/ai/internal/gemini.types';
import { accessibleProductsPredicate } from '@/modules/products/internal/accessible-products.helper';

import type { SalesBotStockPolicy } from '../entities/sales-bot-settings.entity';
import type { ClosedOrder, ClosedOrderItem } from './types';

/** Datos del canal para etiquetar el pedido cerrado (quién y por dónde escribe). */
export interface SellerToolContext {
  companyId: number;
  channel: string;
  chatId: string;
  chatDisplayName?: string;
  /**
   * Política de stock del negocio. Con `offer_always` las herramientas NO le
   * entregan el stock al modelo (no puede mencionarlo) y "populares" incluye
   * productos sin existencias. Default: `inform`.
   */
  stockPolicy?: SalesBotStockPolicy;
}

const FAMILIES_NOTE =
  'Cada elemento de "families" es UN producto con TODAS sus presentaciones (libra, media libra, cuarto, paquete, gramo, caja...). Si el cliente no dijo la presentación, ofrécele las de consumo con su precio y pregúntale cuál prefiere; no escojas una sola. Habla de los productos con naturalidad (no copies el nombre del catálogo en mayúsculas ni con abreviaturas); el "name" exacto solo va en submit_order.';

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

/** Resultado de ejecutar una herramienta: respuesta para el modelo + efecto. */
export interface SellerToolResult {
  /** Objeto que se le devuelve al modelo como functionResponse. */
  response: Record<string, unknown>;
  /** Pedido cerrado (solo lo pone submit_order); el canal avisa al dueño. */
  order?: ClosedOrder;
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

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Filas de inventario que leen las herramientas (sin costos). */
interface InventoryRow {
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
}

/** Máximo de filas (presentaciones) que devuelve una búsqueda. */
const MAX_SEARCH_ROWS = 60;

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

/** Agrupa las filas por familia (producto base + sus presentaciones). */
export const groupFamilies = (
  rows: readonly InventoryRow[],
  hideStock: boolean,
): Array<Record<string, unknown>> => {
  const families = new Map<
    string,
    { product: string; presentations: Array<Record<string, unknown>> }
  >();
  for (const row of rows) {
    const familyId = String(row.family_id);
    const family = families.get(familyId) ?? {
      product: row.family_name,
      presentations: [],
    };
    family.presentations.push({
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
  private readonly logger = new Logger(SellerToolRunner.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(call: GeminiFunctionCall, context: SellerToolContext): Promise<SellerToolResult> {
    const args = call.args ?? {};
    switch (call.name) {
      case 'search_products':
        return {
          response: await this.searchProducts(context.companyId, args, offerAlways(context)),
        };
      case 'get_popular_products':
        return {
          response: await this.popularProducts(context.companyId, args, offerAlways(context)),
        };
      case 'submit_order':
        return this.submitOrder(args, context);
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
    const relevance = `BOOL_OR(${accentInsensitiveLike('p.name', prefixIdx)}) DESC, MIN(p.name) ASC`;

    const rows = await this.dataSource.query<InventoryRow[]>(
      `
      WITH matched AS (
        SELECT
          COALESCE(p.parent_id, p.id) AS family_id,
          ROW_NUMBER() OVER (ORDER BY ${relevance}) AS rank
        FROM products p
        WHERE ${access.sql}
          AND p.is_archived = false
          AND (
            ${accentInsensitiveLike('p.name', searchIdx)}
            OR ${accentInsensitiveLike("COALESCE(p.sku_code, '')", searchIdx)}
            OR ${accentInsensitiveLike("COALESCE(p.bar_code, '')", searchIdx)}
          )
        GROUP BY COALESCE(p.parent_id, p.id)
        -- Primero los que EMPIEZAN por lo buscado ("uva pasa…" antes que
        -- "combinado uva pasa…"); luego alfabético.
        ORDER BY ${relevance}
        LIMIT ${familyLimitIdx}
      )
      SELECT
        COALESCE(p.parent_id, p.id) AS family_id,
        fam.name AS family_name,
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
        ) AS prices
      FROM products p
      JOIN matched m ON m.family_id = COALESCE(p.parent_id, p.id)
      JOIN products fam ON fam.id = m.family_id
      LEFT JOIN products parent ON parent.id = p.parent_id
      LEFT JOIN categories cat ON cat.id = p.category_id
      LEFT JOIN packagings pk ON pk.id = p.packaging_id
      WHERE ${access.sql}
        AND p.is_archived = false
      ORDER BY m.rank ASC, (p.parent_id IS NOT NULL) ASC, pk.value DESC NULLS LAST, p.name ASC
      LIMIT ${rowLimitIdx}
      `,
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
        AND p.is_archived = false
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

  /** Cierra el pedido: calcula totales y lo entrega para avisarle al dueño. */
  private submitOrder(args: Record<string, unknown>, context: SellerToolContext): SellerToolResult {
    const rawItems = Array.isArray(args.items) ? args.items : [];
    const items: ClosedOrderItem[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const item = raw as Record<string, unknown>;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const quantity = num(item.quantity as number);
      const unitPrice = num(item.unit_price as number);
      if (!name || quantity <= 0 || unitPrice < 0) {
        continue;
      }
      items.push({
        name,
        quantity,
        unit_price: unitPrice,
        line_total: round2(quantity * unitPrice),
      });
    }

    if (items.length === 0) {
      return {
        response: {
          status: 'invalid',
          message:
            'No hay líneas válidas en el pedido. Confirma con el cliente qué lleva (producto, cantidad y precio) antes de cerrar.',
        },
      };
    }

    const total = round2(items.reduce((sum, item) => sum + item.line_total, 0));
    const order: ClosedOrder = {
      items,
      total,
      customer_name:
        typeof args.customer_name === 'string' ? args.customer_name.trim() || undefined : undefined,
      customer_phone:
        typeof args.customer_phone === 'string'
          ? args.customer_phone.trim() || undefined
          : undefined,
      delivery: typeof args.delivery === 'string' ? args.delivery.trim() || undefined : undefined,
      notes: typeof args.notes === 'string' ? args.notes.trim() || undefined : undefined,
      channel: context.channel,
      chat_id: context.chatId,
      chat_display_name: context.chatDisplayName,
    };

    this.logger.log(
      { companyId: context.companyId, channel: context.channel, total, lines: items.length },
      'Pedido cerrado por el vendedor',
    );

    return {
      order,
      response: {
        status: 'taken',
        total,
        items: items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unit_price,
          lineTotal: item.line_total,
        })),
        message:
          'Pedido TOMADO y pasado al negocio. Confírmale al cliente con un resumen cálido (productos, cantidades y total) y dile que EL NEGOCIO le confirma en un momento la entrega y el pago. NO digas que el pedido quedó "registrado en el sistema" ni que ya está facturado: tú solo tomas el pedido. Llama esta herramienta UNA sola vez por pedido.',
      },
    };
  }
}
