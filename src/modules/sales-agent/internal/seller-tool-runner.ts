import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { accentInsensitiveLike } from '@/modules/ai/internal/tool-sql';
import type { GeminiFunctionCall } from '@/modules/ai/internal/gemini.types';
import { accessibleProductsPredicate } from '@/modules/products/internal/accessible-products.helper';

import type { ClosedOrder, ClosedOrderItem } from './types';

/** Datos del canal para etiquetar el pedido cerrado (quién y por dónde escribe). */
export interface SellerToolContext {
  companyId: number;
  channel: string;
  chatId: string;
  chatDisplayName?: string;
}

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
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

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
        return { response: await this.searchProducts(context.companyId, args) };
      case 'get_popular_products':
        return { response: await this.popularProducts(context.companyId, args) };
      case 'submit_order':
        return this.submitOrder(args, context);
      default:
        return { response: { error: `Herramienta no disponible: ${call.name}` } };
    }
  }

  /** Inventario por nombre/código: existencias y PRECIOS de venta, sin costos. */
  private async searchProducts(
    companyId: number,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return { error: 'Falta el texto de búsqueda.' };
    }
    const limit = toPositiveInt(args.limit, 10, 1, 25);

    const access = accessibleProductsPredicate('p', companyId, 1);
    const params: unknown[] = [...access.params, `%${query.toLowerCase()}%`, limit];
    const searchIdx = `$${access.params.length + 1}`;
    const limitIdx = `$${access.params.length + 2}`;

    const rows = await this.dataSource.query<
      Array<{
        name: string;
        sku_code: string | null;
        bar_code: string | null;
        stock: string;
        category: string | null;
        packaging: string | null;
        prices: Array<{ name: string; sale_price: string }> | null;
      }>
    >(
      `
      SELECT
        p.name,
        p.sku_code,
        p.bar_code,
        p.stock,
        cat.name AS category,
        pk.name  AS packaging,
        (
          SELECT jsonb_agg(jsonb_build_object('name', pp.name, 'sale_price', pp.sale_price)
                 ORDER BY pp.id ASC)
          FROM product_prices pp
          WHERE pp.product_id = p.id
        ) AS prices
      FROM products p
      LEFT JOIN categories cat ON cat.id = p.category_id
      LEFT JOIN packagings pk ON pk.id = p.packaging_id
      WHERE ${access.sql}
        AND p.is_archived = false
        AND (
          ${accentInsensitiveLike('p.name', searchIdx)}
          OR ${accentInsensitiveLike("COALESCE(p.sku_code, '')", searchIdx)}
          OR ${accentInsensitiveLike("COALESCE(p.bar_code, '')", searchIdx)}
        )
      ORDER BY p.name ASC
      LIMIT ${limitIdx}
      `,
      params,
    );

    return {
      query,
      count: rows.length,
      currency: 'COP',
      products: rows.map((row) => ({
        name: row.name,
        sku: row.sku_code,
        barcode: row.bar_code,
        category: row.category,
        packaging: row.packaging,
        stock: num(row.stock),
        prices: (row.prices ?? []).map((price) => ({
          name: price.name,
          salePrice: num(price.sale_price),
        })),
      })),
      note: 'Precios en pesos (COP). El PRIMER precio de "prices" es el precio por defecto: cotiza SIEMPRE con ese, salvo que el cliente pida otro nivel (p. ej. mayorista). Si te preguntan el precio de un producto, DALO siempre aunque "stock" sea 0 o negativo; la disponibilidad se aclara aparte (no ofrezcas como disponible lo que no hay). Nunca menciones costos ni márgenes.',
    };
  }

  /** Productos más vendidos (últimos 90 días) con stock y precio, para recomendar. */
  private async popularProducts(
    companyId: number,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const limit = toPositiveInt(args.limit, 8, 1, 15);

    // $1 = company, $2 = días de ventana; el predicado de acceso va desde $3.
    const access = accessibleProductsPredicate('p', companyId, 3);
    const params: unknown[] = [companyId, POPULAR_WINDOW_DAYS, ...access.params, limit];
    const limitIdx = `$${params.length}`;

    const rows = await this.dataSource.query<
      Array<{
        name: string;
        stock: string;
        category: string | null;
        packaging: string | null;
        units: string | null;
        prices: Array<{ name: string; sale_price: string }> | null;
      }>
    >(
      `
      SELECT
        p.name,
        p.stock,
        cat.name AS category,
        pk.name  AS packaging,
        COALESCE(sold.units, 0) AS units,
        (
          SELECT jsonb_agg(jsonb_build_object('name', pp.name, 'sale_price', pp.sale_price)
                 ORDER BY pp.id ASC)
          FROM product_prices pp
          WHERE pp.product_id = p.id
        ) AS prices
      FROM products p
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
        AND p.stock > 0
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
        stock: num(row.stock),
        unitsSoldRecently: num(row.units),
        prices: (row.prices ?? []).map((price) => ({
          name: price.name,
          salePrice: num(price.sale_price),
        })),
      })),
      note: 'Sugerencias ordenadas por lo más vendido en los últimos 90 días, solo con stock disponible. Úsalas para recomendar o hacer venta cruzada. Precios en pesos (COP).',
    };
  }

  /** Cierra el pedido: calcula totales y lo entrega para avisarle al dueño. */
  private submitOrder(
    args: Record<string, unknown>,
    context: SellerToolContext,
  ): SellerToolResult {
    const rawItems = Array.isArray(args.items) ? args.items : [];
    const items: ClosedOrderItem[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const quantity = num(item.quantity as number);
      const unitPrice = num(item.unit_price as number);
      if (!name || quantity <= 0 || unitPrice < 0) continue;
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
