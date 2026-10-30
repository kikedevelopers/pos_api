import { randomUUID } from 'node:crypto';

import { HttpException, Injectable, Logger } from '@nestjs/common';
import Big from 'big.js';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber } from '@/common/utils/precision';
import { RealtimeGateway } from '@/modules/realtime/realtime.gateway';
import { CreateSaleAction } from '@/modules/sales/actions/create-sale.action';
import { CreateSaleDto } from '@/modules/sales/dto/create-sale.dto';
import { loadMarginConfig } from '@/modules/sales/internal/margin-guard.helper';

import { hashMessage, PENDING_ACTION_TTL_MINUTES } from '../internal/expense-tool-helpers';
import type { AiToolRequestContext } from '../internal/expense-tool-helpers';
import {
  LOCK_PENDING_ACTION_SQL,
  MARK_PENDING_EXECUTED_SQL,
  MARK_PENDING_EXPIRED_SQL,
  UPSERT_PENDING_ACTION_SQL,
} from '../internal/expense-tool-sql';
import {
  checkPendingConfirmation,
  type PendingActionType,
  wrongOperationResult,
} from '../internal/pending-confirmation';
import { OfferedReferences } from '../internal/offered-references';
import {
  buildCandidatePatterns,
  isFractionCountedTwice,
  matchLine,
  rankSimilarNames,
  parseProduct,
  type LineMatch,
  type MatchableProduct,
} from '../internal/sale-product-matching';
import {
  availableUnits,
  computeSaleTotals,
  marginFromPrices,
  mergePricedLines,
  priceLine,
  readPositiveId,
  readSaleItemsArg,
  visibleLineKey,
  type PricedLine,
  type SaleItemRequest,
  type SaleTotals,
  toSellableProduct,
  type SellableDetailRow,
  type SellableProduct,
} from '../internal/sale-tool-helpers';
import {
  buildCandidatePoolSql,
  buildCustomerFuzzySql,
  CANDIDATE_POOL_LIMIT,
  CUSTOMER_CANDIDATES_LIMIT,
  buildCustomerSearchSql,
  buildSellableDetailsSql,
  FIND_ACTIVE_CUSTOMER_SQL,
} from '../internal/sale-tool-sql';
import { readString } from '../internal/tool-args';
import type { AiToolActor } from '../internal/tool-catalog';

/** Snapshot exacto del pedido que vio el usuario (vive en `ai_pending_actions`). */
interface SalePayload {
  /** Llave de idempotencia del pedido (`sale_invoices.client_operation_id`). */
  operation_id: string;
  customer_id: number | null;
  customer_name: string | null;
  lines: PricedLine[];
  totals: SaleTotals;
}

interface PoolRow {
  id: string;
  name: string;
  sku_code: string | null;
  bar_code: string | null;
  packaging_name: string | null;
}

interface CustomerRow {
  id: string;
  name: string;
  doc_number: string | null;
  phone: string | null;
  is_exact?: boolean;
  total_matches?: string;
}

interface PendingRow {
  id: string;
  action_type: PendingActionType;
  payload: SalePayload;
  request_id: string;
  trigger_message_hash: string;
  is_expired: boolean;
}

interface PoolProduct extends MatchableProduct {
  id: number;
}

interface ItemPool {
  pool: PoolProduct[];
  /** El pool llegó al tope: pudo quedar fuera el producto correcto. */
  truncated: boolean;
}

type ItemMatch =
  | LineMatch<PoolProduct>
  | { status: 'too_broad' }
  /** Un product_id que la herramienta no ofreció en esta petición. */
  | { status: 'stale_reference' };

type CustomerResolution =
  | { status: 'walk_in' }
  | { status: 'ok'; customer: CustomerRow }
  | { status: 'not_found'; query: string }
  | { status: 'ambiguous'; options: CustomerRow[]; total: number; fuzzy?: boolean }
  /** Un customer_id que la herramienta no ofreció en esta petición. */
  | { status: 'stale_reference' };

/** Consultas simultáneas máximas del plan B (pool por línea). */
const FALLBACK_POOL_CONCURRENCY = 4;

/** Ids máximos a los que se les trae detalle (elegidos + opciones mostradas). */
const MAX_DETAIL_IDS = 80;

const WALK_IN_LABEL = 'Mostrador (sin cliente)';

/** Cómo debe mostrarle el modelo las opciones de cliente al usuario. */
const CUSTOMER_OPTIONS_RULE =
  'Lista las opciones usando EXACTAMENTE el campo "display" de cada una. NUNCA inventes documentos ni teléfonos, y NUNCA muestres el customer_id: si un cliente no tiene documento, no le pongas uno.';

/** "JHOANA MOGOLLON · Doc. 1110 · Tel. 300…"; solo los datos que existen. */
export const describeCustomerOption = (row: {
  name: string;
  doc_number: string | null;
  phone: string | null;
}): string =>
  [
    row.name,
    row.doc_number?.trim() ? `Doc. ${row.doc_number.trim()}` : null,
    row.phone?.trim() ? `Tel. ${row.phone.trim()}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** "3 litro" + "caja" → "3 litro caja"; sin nada → null. */
const describeSize = (size: string | null, pack: string | null): string | null =>
  [size, pack].filter(Boolean).join(' ') || null;

const money = (value: Big | string): number => preciseNumber(new Big(value), 2);
const units = (value: Big | string): number => preciseNumber(new Big(value), 4);

/** Las violaciones del DTO en una frase (incluye las de las líneas anidadas). */
const describeViolations = (errors: readonly ValidationError[]): string =>
  errors
    .flatMap(function collect(error: ValidationError): string[] {
      return [
        ...Object.values(error.constraints ?? {}),
        ...(error.children ?? []).flatMap(collect),
      ];
    })
    .join('. ');

/** Mensaje legible de una excepción HTTP de `CreateSaleAction`. */
const httpErrorMessage = (error: HttpException): string => {
  const response = error.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) {
    return message.join('. ');
  }
  return typeof message === 'string' ? message : error.message;
};

/**
 * Herramienta de PEDIDOS de Place: el usuario dice "véndele a Juan 2 libras de
 * fécula y un aceite" y Place deja creado el PEDIDO por cobrar (ORDER), que
 * aparece en Tickets del POS para cobrarlo desde allí.
 *
 * Mismo flujo de dos turnos que los gastos, forzado por el servidor:
 *
 *   1. `prepare_sale` interpreta y resuelve TODO en una sola llamada (cliente,
 *      cada producto con sus sinónimos y tamaños, nivel de precio o precio
 *      manual, totales). Si algo es dudoso devuelve las opciones y NO guarda
 *      nada. Si todo cuadra guarda la pendiente con el snapshot exacto del
 *      pedido y devuelve la vista previa de la factura.
 *   2. `confirm_sale` lo crea solo con el "sí" explícito del usuario a ESE
 *      resumen, en una petición posterior. Revalida contra la BD dentro de la
 *      transacción (producto vendible y accesible, mismo precio) y crea el
 *      pedido con `CreateSaleAction.runInTransaction` — la misma lógica de
 *      `POST /sales` — junto con la marca EXECUTED: exactly-once.
 *
 * El pedido NO mueve dinero ni descuenta stock: eso pasa al cobrarlo en el POS,
 * con sus propias reglas (margen, inventario estricto, permisos de cobro).
 */
@Injectable()
export class RunAiSaleToolAction {
  private readonly logger = new Logger(RunAiSaleToolAction.name);

  /** Ids ofrecidos por petición: solo esos se aceptan como referencia. */
  private readonly offered = new OfferedReferences();

  constructor(
    private readonly dataSource: DataSource,
    private readonly createSale: CreateSaleAction,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // prepare_sale
  // ────────────────────────────────────────────────────────────────────────

  async prepareSale(
    company_id: number,
    actor: AiToolActor,
    args: Record<string, unknown>,
    context: AiToolRequestContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (!context?.current_user_message) {
      return this.unavailable();
    }

    const items = readSaleItemsArg(args);
    if (items.status === 'missing') {
      return {
        status: 'missing_data',
        missing: ['qué productos y cuántos de cada uno'],
        message:
          'NO se preparó nada. Pregúntale al usuario qué productos lleva y en qué cantidad (sin suponerlos).',
      };
    }
    if (items.status === 'invalid') {
      return {
        status: 'invalid_data',
        invalid: [items.reason],
        message: 'NO se preparó nada. Corrige los datos con el usuario y vuelve a llamar.',
      };
    }

    const customer_id = readPositiveId(args.customer_id);
    if (customer_id === 'invalid') {
      return {
        status: 'invalid_data',
        invalid: ['La referencia del cliente no es válida.'],
        message: 'NO se preparó nada. Usa el customer_id de la lista que devolvió la herramienta.',
      };
    }
    const customer_query = readString(args, 'customer') ?? null;
    const needs_margin = items.items.some((item) => item.unit_price.status === 'ok');

    // Un id solo vale si ESTA petición lo ofreció: entre turnos el modelo no
    // conserva los ids (el historial es texto) y los inventa. Si además mandó
    // el nombre, se ignora el id y se busca por nombre; si no, se le pide.
    const request_id = context.request_id;
    const stale_lines = new Set<number>();
    const requested_items = items.items.map((item) => {
      if (
        item.product_id === null ||
        this.offered.wasOffered(request_id, 'product', item.product_id)
      ) {
        return item;
      }
      if (item.query === null) {
        stale_lines.add(item.position);
        return item;
      }
      return { ...item, product_id: null };
    });
    const customer_is_stale =
      customer_id !== null && !this.offered.wasOffered(request_id, 'customer', customer_id);
    const effective_customer_id = customer_is_stale ? null : customer_id;

    // Viajes independientes en paralelo: pool de productos, cliente y márgenes.
    const [pools, customer, minimum_margin] = await Promise.all([
      this.fetchPools(company_id, requested_items),
      customer_is_stale && customer_query === null
        ? Promise.resolve<CustomerResolution>({ status: 'stale_reference' })
        : this.resolveCustomer(company_id, effective_customer_id, customer_query),
      needs_margin
        ? this.minimumMargin(this.dataSource.manager, company_id)
        : Promise.resolve(null),
    ]);

    const matches: ItemMatch[] = requested_items.map((item, index) =>
      stale_lines.has(item.position)
        ? { status: 'stale_reference' }
        : this.matchItem(item, pools[index]),
    );
    const offered_products = this.idsToDetail(matches);
    const details = await this.fetchDetails(this.dataSource.manager, company_id, offered_products);
    // Lo que se le muestra al modelo en esta respuesta queda como referencia
    // válida para que reintente con ids en ESTA misma petición.
    this.offered.remember(request_id, 'product', offered_products);
    this.offered.remember(request_id, 'customer', this.customerIdsOf(customer));

    const priced: PricedLine[] = [];
    const lines: Array<Record<string, unknown>> = [];
    let has_issues = false;

    for (const [index, item] of requested_items.entries()) {
      const match = matches[index];
      const described = this.describeLine(item, match, details, minimum_margin);
      lines.push(described.view);
      if (described.line) {
        priced.push(described.line);
      } else {
        has_issues = true;
      }
    }

    const customer_view = this.describeCustomer(customer);
    if (
      customer.status === 'not_found' ||
      customer.status === 'ambiguous' ||
      customer.status === 'stale_reference'
    ) {
      has_issues = true;
    }

    if (has_issues) {
      return {
        status: 'needs_input',
        customer: customer_view,
        lines,
        message:
          'NO se preparó el pedido: hay datos por resolver. Muéstrale al usuario SOLO lo que falta (líneas con status distinto de "ok" y el cliente si no quedó claro), con sus opciones, y pregúntale. Si un tamaño no existe, sugiérele los disponibles (los menores primero) con la cantidad equivalente. Cuando responda (en su próximo mensaje), vuelve a llamar prepare_sale con TODAS las líneas usando el NOMBRE EXACTO de la opción que eligió en "query" / "customer" (los product_id / customer_id solo sirven dentro de esta misma respuesta).',
      };
    }

    const merged = mergePricedLines(priced);
    const totals = computeSaleTotals(merged);
    if (!new Big(totals.total).gt(0)) {
      return {
        status: 'invalid_data',
        invalid: ['El total del pedido debe ser mayor a cero.'],
        message: 'NO se preparó nada. Revisa los precios con el usuario.',
      };
    }

    const resolved_customer = customer.status === 'ok' ? customer.customer : null;
    const payload: SalePayload = {
      operation_id: randomUUID(),
      customer_id: resolved_customer ? Number(resolved_customer.id) : null,
      customer_name: resolved_customer ? resolved_customer.name : null,
      lines: merged,
      totals,
    };

    const saved = await this.savePending(company_id, actor.userId, payload, context);
    if (saved !== 'saved') {
      return this.notSaved(saved);
    }

    return {
      status: 'confirmation_required',
      summary: this.buildSummary(payload, details),
      message:
        'AÚN NO está creado. El usuario YA está viendo esta vista previa como una tarjeta de factura que dibuja el sistema con estos datos exactos: NO la repitas ni la reescribas (nada de tablas ni de listar productos, cantidades o precios). Responde en una o dos frases: que revise la vista previa, menciona las advertencias si las hay, y pídele que responda "sí" para crear el pedido. Si quiere cambiar algo, vuelve a llamar prepare_sale con los datos nuevos.',
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // confirm_sale
  // ────────────────────────────────────────────────────────────────────────

  async confirmSale(
    company_id: number,
    actor: AiToolActor,
    context: AiToolRequestContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (!context?.current_user_message) {
      return this.unavailable();
    }
    const creator = { id: actor.userId, fullName: actor.full_name?.trim() || 'Usuario' };

    let created: { id: number; ticket_number: string } | null = null;
    let outcome: Record<string, unknown>;
    try {
      outcome = await this.dataSource.transaction(async (manager) => {
        const [pending] = await manager.query<PendingRow[]>(LOCK_PENDING_ACTION_SQL, [
          String(company_id),
          String(actor.userId),
        ]);
        if (!pending) {
          return {
            status: 'no_pending_action',
            message:
              'No hay ningún pedido pendiente de confirmar. NO se creó nada. Si el usuario quiere registrar una venta, prepárala primero con prepare_sale.',
          };
        }
        if (pending.action_type !== 'CREATE_SALE') {
          return wrongOperationResult(pending.action_type);
        }

        const expire = (): Promise<unknown> =>
          manager.query(MARK_PENDING_EXPIRED_SQL, [pending.id, String(company_id)]);

        const rejection = checkPendingConfirmation(pending, context);
        if (rejection) {
          if (rejection.expire) {
            await expire();
          }
          return { status: rejection.status, message: rejection.message };
        }

        const payload = pending.payload;
        const refreshed = await this.revalidate(manager, company_id, payload);
        if (refreshed.status !== 'ok') {
          await expire();
          return { status: 'changed', message: refreshed.message };
        }

        const totals = computeSaleTotals(refreshed.lines);
        const dto: CreateSaleDto = {
          items: refreshed.lines.map((line) => ({
            item_id: line.product_id,
            name: line.name,
            cost: Number(line.cost),
            price: Number(line.unit_price),
            quantity: Number(line.quantity),
            total: Number(line.total),
            profit: Number(line.profit),
            margin: Number(line.margin),
            price_mode: line.price_mode,
            price_position: line.price_position,
            note: line.note,
          })),
          total: Number(totals.total),
          cost: Number(totals.cost),
          profit: Number(totals.profit),
          margin: Number(totals.margin),
          customer_id: payload.customer_id,
          customer_name: payload.customer_name,
          client_operation_id: payload.operation_id,
        };

        // Mismas reglas del DTO que `POST /sales` (largos, escalas, enums): el
        // pedido de Place no se salta el ValidationPipe.
        const violations = await validate(plainToInstance(CreateSaleDto, dto));
        if (violations.length > 0) {
          await expire();
          return {
            status: 'failed',
            message: `NO se creó el pedido: ${describeViolations(violations)}. Explícaselo al usuario.`,
          };
        }

        const { sale } = await this.createSale.runInTransaction(manager, dto, company_id, creator);
        await manager.query(MARK_PENDING_EXECUTED_SQL, [
          pending.id,
          String(company_id),
          String(sale.id),
        ]);
        created = { id: Number(sale.id), ticket_number: sale.ticket_number };

        this.logger.log({
          event: 'ai.sale.created',
          companyId: company_id,
          userId: actor.userId,
          pendingActionId: Number(pending.id),
          saleId: Number(sale.id),
          ticketNumber: sale.ticket_number,
          total: totals.total,
        });

        return {
          status: 'executed',
          order: {
            // Id interno: el chat lo usa para abrir el visor del pedido.
            sale_id: Number(sale.id),
            ticket_number: sale.ticket_number,
            customer: payload.customer_name ?? WALK_IN_LABEL,
            lines: refreshed.lines.length,
            total: money(totals.total),
          },
          message:
            'Pedido creado. El usuario ya ve la tarjeta del pedido creado (ticket y total). Confírmaselo en una frase, sin repetir la factura, y dile que queda en Tickets del POS para cobrarlo (el inventario se descuenta al cobrar).',
        };
      });
    } catch (error) {
      // Rollback completo: ni pedido, ni pendiente ejecutada.
      if (error instanceof HttpException) {
        return {
          status: 'failed',
          message: `NO se creó el pedido: ${httpErrorMessage(error)}. Explícaselo al usuario.`,
        };
      }
      throw error;
    }

    if (created !== null) {
      this.notifyTicketChanged(company_id, actor.userId, created);
    }
    return outcome;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Resolución de productos
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Pool de candidatos de cada línea. Normalmente UNA consulta para todo el
   * pedido; si esa se llena (tope `CANDIDATE_POOL_LIMIT`), el producto correcto
   * podría haber quedado fuera, así que cada línea trae su propio pool (en
   * paralelo). Una línea cuyo pool propio también se llena no se interpreta
   * por nombre (`truncated`).
   */
  private async fetchPools(
    company_id: number,
    items: readonly SaleItemRequest[],
  ): Promise<ItemPool[]> {
    const combined = await this.queryPool(company_id, items);
    if (!combined.truncated) {
      return items.map(() => combined);
    }
    // Concurrencia acotada: un pedido de 40 líneas no debe acaparar el pool de
    // conexiones que comparten todos los tenants.
    const pools: ItemPool[] = [];
    for (let start = 0; start < items.length; start += FALLBACK_POOL_CONCURRENCY) {
      const batch = items.slice(start, start + FALLBACK_POOL_CONCURRENCY);
      pools.push(...(await Promise.all(batch.map((item) => this.queryPool(company_id, [item])))));
    }
    return pools;
  }

  private async queryPool(
    company_id: number,
    items: readonly SaleItemRequest[],
  ): Promise<ItemPool> {
    const queries = items.flatMap((item) =>
      [item.query, ...item.alternatives].filter((query): query is string => query !== null),
    );
    const codes = [
      ...new Set(
        items
          .map((item) => item.query?.trim().toLowerCase() ?? '')
          .filter((code) => code.length > 0 && code.length <= 64 && !/\s/.test(code)),
      ),
    ];
    const product_ids = [
      ...new Set(items.map((item) => item.product_id).filter((id): id is number => id !== null)),
    ];
    const { sql, params } = buildCandidatePoolSql(company_id, {
      patterns: buildCandidatePatterns(queries),
      codes,
      product_ids,
    });
    const rows = await this.dataSource.query<PoolRow[]>(sql, params);
    return {
      truncated: rows.length >= CANDIDATE_POOL_LIMIT,
      pool: rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        sku_code: row.sku_code,
        bar_code: row.bar_code,
        packaging_name: row.packaging_name,
      })),
    };
  }

  private matchItem(item: SaleItemRequest, { pool, truncated }: ItemPool): ItemMatch {
    if (item.product_id !== null) {
      const product = pool.find((candidate) => candidate.id === item.product_id);
      return product
        ? { status: 'resolved', product, via: 'code' }
        : { status: 'not_found', similar: [] };
    }
    const queries = [item.query, ...item.alternatives].filter(
      (query): query is string => query !== null,
    );
    const match = matchLine(
      queries,
      pool,
      item.quantity.status === 'ok' ? item.quantity.quantity : null,
    );
    // Con el pool lleno, el "mejor" por nombre podría no ser el mejor real.
    // Por código exacto sí es seguro (el código es único).
    if (truncated && !(match.status === 'resolved' && match.via === 'code')) {
      return { status: 'too_broad' };
    }
    return match;
  }

  /** Ids a los que se les trae precio: primero los resueltos (van al pedido), luego las opciones. */
  private idsToDetail(matches: readonly ItemMatch[]): number[] {
    const resolved = new Set<number>();
    const options = new Set<number>();
    for (const match of matches) {
      if (match.status === 'resolved') {
        resolved.add(match.product.id);
      } else if (match.status === 'ambiguous') {
        match.options.forEach((product) => options.add(product.id));
      } else if (match.status === 'size_unavailable') {
        match.alternatives.forEach((alternative) => options.add(alternative.product.id));
      } else if (match.status === 'not_found') {
        match.similar.forEach((product) => options.add(product.id));
      }
      // too_broad / stale_reference: no ofrecen productos.
    }
    const extra = [...options].filter((id) => !resolved.has(id));
    return [...resolved, ...extra.slice(0, Math.max(0, MAX_DETAIL_IDS - resolved.size))];
  }

  private async fetchDetails(
    manager: EntityManager,
    company_id: number,
    ids: readonly number[],
  ): Promise<Map<number, SellableProduct>> {
    if (ids.length === 0) {
      return new Map();
    }
    const { sql, params } = buildSellableDetailsSql(company_id, ids);
    const rows = await manager.query<SellableDetailRow[]>(sql, params);
    return new Map(rows.map((row) => [Number(row.id), toSellableProduct(row)]));
  }

  private async minimumMargin(manager: EntityManager, company_id: number): Promise<number | null> {
    const config = await loadMarginConfig(manager, company_id);
    return config.enabled ? config.minimum : null;
  }

  /** Opción que se le muestra al usuario para elegir (nunca el costo). */
  private describeOption(
    product: MatchableProduct,
    details: ReadonlyMap<number, SellableProduct>,
  ): Record<string, unknown> {
    const detail = details.get(product.id);
    const stock = detail ? availableUnits(detail) : null;
    return {
      product_id: product.id,
      name: product.name,
      price: detail && detail.prices.length > 0 ? money(detail.prices[0].sale_price) : null,
      stock: stock !== null ? units(stock) : null,
    };
  }

  /**
   * Una línea tal como la ve el modelo + la línea con precio si quedó lista.
   */
  private describeLine(
    item: SaleItemRequest,
    match: ItemMatch,
    details: ReadonlyMap<number, SellableProduct>,
    minimum_margin: number | null,
  ): { view: Record<string, unknown>; line: PricedLine | null } {
    const base = {
      line: item.position,
      requested: item.query ?? (item.product_id !== null ? `#${item.product_id}` : null),
      quantity: item.quantity.status === 'ok' ? units(item.quantity.quantity) : null,
    };

    // Lo que dijo el modelo y, si ya se resolvió, el nombre real del producto
    // (un product_id de "X MEDIA LIBRA" con cantidad 0.5 también es doble conteo).
    const said = [
      item.query,
      ...item.alternatives,
      match.status === 'resolved' ? match.product.name : null,
    ].filter((query): query is string => query !== null);
    if (item.quantity.status === 'ok' && isFractionCountedTwice(said, item.quantity.quantity)) {
      return {
        view: {
          ...base,
          status: 'fraction_counted_twice',
          message:
            'La fracción quedó contada dos veces: el tamaño ya dice "media"/"cuarto" y la cantidad también es fraccionaria. "Media libra de X" es quantity 1 con query "X por media libra" (o quantity 0.5 con "X por libra"). Corrige la línea y vuelve a llamar; pregúntale al usuario solo si de verdad no está claro.',
        },
        line: null,
      };
    }

    if (match.status === 'stale_reference') {
      return {
        view: {
          ...base,
          status: 'stale_reference',
          message:
            'Ese product_id no salió de esta respuesta (los ids no se conservan entre mensajes). Vuelve a llamar con el NOMBRE EXACTO del producto en "query".',
        },
        line: null,
      };
    }
    if (match.status === 'too_broad') {
      return {
        view: {
          ...base,
          status: 'too_broad',
          message:
            'La búsqueda es demasiado amplia para elegir con seguridad. Pídele al usuario el nombre más completo del producto (marca, presentación) o su código.',
        },
        line: null,
      };
    }
    if (match.status === 'ambiguous') {
      return {
        view: {
          ...base,
          status: 'ambiguous',
          options: match.options.map((product) => this.describeOption(product, details)),
          message: 'Varios productos coinciden: pregúntale cuál.',
        },
        line: null,
      };
    }
    if (match.status === 'size_unavailable') {
      return {
        view: {
          ...base,
          status: 'size_unavailable',
          requested_size: match.requested_size,
          alternatives: match.alternatives.map((alternative) => {
            const option = this.describeOption(alternative.product, details);
            const price = option.price as number | null;
            return {
              ...option,
              size: describeSize(alternative.size?.label ?? null, alternative.pack),
              equivalent_quantity: alternative.equivalent_quantity,
              equivalent_total:
                alternative.equivalent_quantity !== null && price !== null
                  ? money(new Big(price).times(alternative.equivalent_quantity).round(2))
                  : null,
            };
          }),
          message: `No hay "${match.requested_size}" de este producto. Sugiérele los tamaños disponibles (los menores primero) con la cantidad equivalente y pregúntale cuál prefiere.`,
        },
        line: null,
      };
    }
    if (match.status === 'not_found') {
      return {
        view: {
          ...base,
          status: 'not_found',
          similar: match.similar.map((product) => this.describeOption(product, details)),
          message:
            item.product_id !== null
              ? 'Ese producto no existe, está archivado o no se vende en el POS.'
              : 'No se encontró el producto con ese nombre. Si el usuario usó una marca o un nombre coloquial y aún no mandaste "alternatives", NO le preguntes todavía: vuelve a llamar prepare_sale YA, en esta misma respuesta, con el nombre genérico en "alternatives" (ej. "maizena" → "fécula de maíz"). Si ya lo intentaste, muéstrale los similares (si hay) y pregúntale.',
        },
        line: null,
      };
    }

    const product = details.get(match.product.id);
    const resolved = { product_id: match.product.id, name: match.product.name };
    if (!product) {
      return {
        view: {
          ...base,
          status: 'not_found',
          similar: [],
          message: 'El producto ya no está disponible.',
        },
        line: null,
      };
    }
    if (item.quantity.status !== 'ok') {
      return {
        view: {
          ...base,
          status: item.quantity.status === 'missing' ? 'missing_quantity' : 'invalid_quantity',
          product: resolved,
          message:
            item.quantity.status === 'invalid'
              ? item.quantity.reason
              : 'Falta la cantidad: pregúntasela (no la supongas).',
        },
        line: null,
      };
    }
    if (item.unit_price.status === 'invalid') {
      return {
        view: {
          ...base,
          status: 'invalid_price',
          product: resolved,
          message: item.unit_price.reason,
        },
        line: null,
      };
    }

    const priced = priceLine({
      product,
      quantity: item.quantity.quantity,
      price_level: item.price_level,
      manual_price: item.unit_price.status === 'ok' ? item.unit_price.amount : null,
      note: item.note,
      minimum_margin,
    });
    if (priced.status !== 'ok') {
      return {
        view: {
          ...base,
          status: priced.status,
          product: resolved,
          price_levels: priced.price_levels,
          message: priced.message,
        },
        line: null,
      };
    }
    return {
      view: {
        ...base,
        status: 'ok',
        product: resolved,
        unit_price: money(priced.line.unit_price),
        price_label: priced.line.price_label,
        total: money(priced.line.total),
      },
      line: priced.line,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Cliente
  // ────────────────────────────────────────────────────────────────────────

  private async resolveCustomer(
    company_id: number,
    customer_id: number | null,
    query: string | null,
  ): Promise<CustomerResolution> {
    if (customer_id !== null) {
      const [row] = await this.dataSource.query<CustomerRow[]>(FIND_ACTIVE_CUSTOMER_SQL, [
        String(customer_id),
        String(company_id),
      ]);
      return row
        ? { status: 'ok', customer: row }
        : { status: 'not_found', query: `#${customer_id}` };
    }
    if (query === null) {
      return { status: 'walk_in' };
    }
    const { sql, params } = buildCustomerSearchSql(company_id, query);
    const rows = await this.dataSource.query<CustomerRow[]>(sql, params);
    if (rows.length === 0) {
      return this.resolveCustomerFuzzy(company_id, query);
    }
    const exact = rows.filter((row) => row.is_exact === true);
    if (exact.length === 1) {
      return { status: 'ok', customer: exact[0] };
    }
    const total = Number(rows[0].total_matches ?? rows.length);
    if (total === 1) {
      // Único que contiene las palabras, pero no es exacto: si hay otros con
      // nombre PARECIDO ("Jhoanna" → JHOANNA GARCIA, pero también JHOANA
      // MOGOLLON), se pregunta en vez de elegir.
      const similar = await this.resolveCustomerFuzzy(company_id, query);
      if (similar.status === 'ambiguous') {
        const others = similar.options.filter((row) => row.id !== rows[0].id);
        if (others.length > 0) {
          const options = [rows[0], ...others].slice(0, CUSTOMER_CANDIDATES_LIMIT);
          return { status: 'ambiguous', options, total: options.length, fuzzy: true };
        }
      }
      return { status: 'ok', customer: rows[0] };
    }
    return { status: 'ambiguous', options: exact.length > 1 ? exact : rows, total };
  }

  /**
   * Sin coincidencia por palabras completas: busca nombres PARECIDOS
   * ("Jhoanna" → "JHOANA MOGOLLON"). Nunca resuelve solo: devuelve las
   * opciones para que el usuario confirme cuál ("¿quisiste decir…?").
   */
  private async resolveCustomerFuzzy(
    company_id: number,
    query: string,
  ): Promise<CustomerResolution> {
    const fuzzy = buildCustomerFuzzySql(company_id, query);
    if (fuzzy === null) {
      return { status: 'not_found', query };
    }
    const rows = await this.dataSource.query<CustomerRow[]>(fuzzy.sql, fuzzy.params);
    const options = rankSimilarNames(query, rows, (row) => row.name).slice(
      0,
      CUSTOMER_CANDIDATES_LIMIT,
    );
    return options.length > 0
      ? { status: 'ambiguous', options, total: options.length, fuzzy: true }
      : { status: 'not_found', query };
  }

  /** Clientes que esta respuesta le muestra al modelo (referencias válidas). */
  private customerIdsOf(resolution: CustomerResolution): number[] {
    if (resolution.status === 'ok') {
      return [Number(resolution.customer.id)];
    }
    if (resolution.status === 'ambiguous') {
      return resolution.options.map((row) => Number(row.id));
    }
    return [];
  }

  private describeCustomer(resolution: CustomerResolution): Record<string, unknown> {
    const view = (row: CustomerRow): Record<string, unknown> => ({
      customer_id: Number(row.id),
      name: row.name,
      document: row.doc_number?.trim() || null,
      phone: row.phone?.trim() || null,
      // Lo que se le muestra al usuario, armado aquí: el modelo inventaba
      // documentos (disfrazaba el id de cédula) cuando el cliente no tenía.
      display: describeCustomerOption(row),
    });
    switch (resolution.status) {
      case 'walk_in':
        return {
          status: 'walk_in',
          name: WALK_IN_LABEL,
          message: 'El usuario no dijo cliente: el pedido queda de mostrador.',
        };
      case 'ok':
        return { status: 'ok', ...view(resolution.customer) };
      case 'not_found':
        return {
          status: 'not_found',
          requested: resolution.query,
          message:
            'No existe ese cliente activo. Pregúntale el nombre o documento correcto, o si el pedido va sin cliente (mostrador). Place no crea clientes.',
        };
      case 'ambiguous':
        return {
          status: 'ambiguous',
          total_matches: resolution.total,
          options: resolution.options.map(view),
          message: resolution.fuzzy
            ? `No hay un cliente con ese nombre exacto, pero estos se parecen (puede ser un error de escritura). Pregúntale cuál es ("¿quisiste decir…?"). ${CUSTOMER_OPTIONS_RULE}`
            : `Varios clientes coinciden: pregúntale cuál es. ${CUSTOMER_OPTIONS_RULE}`,
        };
      case 'stale_reference':
        return {
          status: 'stale_reference',
          message:
            'Ese customer_id no salió de esta respuesta (los ids no se conservan entre mensajes). Vuelve a llamar con el NOMBRE o documento del cliente en "customer".',
        };
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Vista previa
  // ────────────────────────────────────────────────────────────────────────

  private buildSummary(
    payload: SalePayload,
    details: ReadonlyMap<number, SellableProduct>,
  ): Record<string, unknown> {
    const warnings: string[] = [];
    const requested_by_product = new Map<number, Big>();
    for (const line of payload.lines) {
      requested_by_product.set(
        line.product_id,
        (requested_by_product.get(line.product_id) ?? new Big(0)).plus(line.quantity),
      );
    }
    for (const [product_id, requested] of requested_by_product) {
      const product = details.get(product_id);
      const available = product ? availableUnits(product) : null;
      if (product && available !== null && available.lt(requested)) {
        warnings.push(
          `Existencias de ${product.name}: hay ${units(available)} y el pedido lleva ${units(requested)}. Al cobrarlo, si el negocio controla inventario estricto, no se podrá.`,
        );
      }
    }
    for (const line of payload.lines) {
      if (line.price_mode === 'manual') {
        warnings.push(`${line.name} va con precio manual (${money(line.unit_price)}).`);
      }
    }

    return {
      operation: 'Crear pedido por cobrar',
      customer: payload.customer_name ?? WALK_IN_LABEL,
      lines: payload.lines.map((line, index) => ({
        line: index + 1,
        product: line.name,
        size: ((): string | null => {
          const parsed = parseProduct({
            id: line.product_id,
            name: line.name,
            sku_code: null,
            bar_code: null,
            packaging_name: details.get(line.product_id)?.packaging_name ?? null,
          });
          return describeSize(parsed.size?.label ?? null, parsed.pack);
        })(),
        quantity: units(line.quantity),
        unit_price: money(line.unit_price),
        price_label: line.price_label,
        total: money(line.total),
        // Ganancia y margen: `stripProfitFields` los quita antes de salir del
        // servidor si el usuario no puede ver ganancias (misma regla del visor
        // de tickets: owner siempre; el empleado según `can_view_profit`).
        profit: money(line.profit),
        margin: preciseNumber(new Big(line.margin), 2),
        note: line.note,
      })),
      items_count: payload.lines.length,
      total: money(payload.totals.total),
      profit: money(payload.totals.profit),
      margin: preciseNumber(new Big(payload.totals.margin), 2),
      warnings,
      after_confirm:
        'Queda como pedido en Tickets del POS para cobrarlo desde allí. No descuenta inventario ni mueve dinero hasta que se cobre.',
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Revalidación al confirmar
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Vuelve a poner precio a cada línea con los datos ACTUALES (dentro de la
   * transacción) y exige que lo que el usuario vio no haya cambiado: mismo
   * producto vendible y accesible, misma cantidad, mismo precio, mismo total.
   * El costo sí se refresca (el usuario no lo vio; el POS toma el vigente).
   */
  private async revalidate(
    manager: EntityManager,
    company_id: number,
    payload: SalePayload,
  ): Promise<{ status: 'ok'; lines: PricedLine[] } | { status: 'changed'; message: string }> {
    const lines = Array.isArray(payload?.lines) ? payload.lines : [];
    if (lines.length === 0) {
      return {
        status: 'changed',
        message: 'El pedido preparado no tiene productos. NO se creó nada.',
      };
    }
    const ids = [...new Set(lines.map((line) => Number(line.product_id)))];
    const has_manual = lines.some((line) => line.price_mode === 'manual');
    const [details, minimum_margin] = await Promise.all([
      this.fetchDetails(manager, company_id, ids),
      has_manual ? this.minimumMargin(manager, company_id) : Promise.resolve(null),
    ]);

    const refreshed: PricedLine[] = [];
    for (const line of lines) {
      const product = details.get(Number(line.product_id));
      if (!product) {
        return {
          status: 'changed',
          message: `${line.name} ya no está disponible para la venta. NO se creó el pedido. Vuelve a prepararlo.`,
        };
      }
      // Manual: mismas reglas de costo y margen mínimo, con el costo de HOY.
      // Fijo: el nivel por POSICIÓN (no por nombre), que es lo que guarda el pedido.
      let repriced: PricedLine | null = null;
      if (line.price_mode === 'manual') {
        const priced = priceLine({
          product,
          quantity: new Big(line.quantity),
          price_level: null,
          manual_price: new Big(line.unit_price),
          note: line.note,
          minimum_margin,
        });
        repriced = priced.status === 'ok' ? priced.line : null;
      } else if (line.price_position !== null) {
        repriced = this.repriceAtPosition(line, product, line.price_position);
      }

      if (repriced === null || visibleLineKey(repriced) !== visibleLineKey(line)) {
        return {
          status: 'changed',
          message: `El precio o los datos de ${line.name} cambiaron desde que se mostró el resumen. NO se creó el pedido. Vuelve a prepararlo para mostrar los valores actuales.`,
        };
      }
      refreshed.push(repriced);
    }
    return { status: 'ok', lines: refreshed };
  }

  private repriceAtPosition(
    line: PricedLine,
    product: SellableProduct,
    position: number,
  ): PricedLine | null {
    const price = product.prices[position];
    if (!price) {
      return null;
    }
    const unit_price = price.sale_price.round(2);
    const quantity = new Big(line.quantity);
    const cost = product.cost.round(2);
    const unit_profit = unit_price.minus(cost).round(2);
    return {
      ...line,
      unit_price: unit_price.toFixed(2),
      cost: cost.toFixed(2),
      price_position: position,
      price_label: price.name.trim() || `Precio ${position + 1}`,
      total: unit_price.times(quantity).round(2).toFixed(2),
      profit: unit_profit.times(quantity).round(2).toFixed(2),
      margin: marginFromPrices(unit_price, cost).toFixed(4),
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Pendiente
  // ────────────────────────────────────────────────────────────────────────

  private async savePending(
    company_id: number,
    user_id: number,
    payload: SalePayload,
    context: AiToolRequestContext,
  ): Promise<'saved' | 'one_at_a_time' | 'concurrent'> {
    try {
      const rows = await this.dataSource.query<Array<{ id: string }>>(UPSERT_PENDING_ACTION_SQL, [
        String(company_id),
        String(user_id),
        'CREATE_SALE',
        JSON.stringify(payload),
        context.request_id,
        hashMessage(context.current_user_message ?? ''),
        PENDING_ACTION_TTL_MINUTES,
      ]);
      return rows.length > 0 ? 'saved' : 'one_at_a_time';
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        return 'concurrent';
      }
      throw error;
    }
  }

  private notSaved(outcome: 'one_at_a_time' | 'concurrent'): Record<string, unknown> {
    if (outcome === 'one_at_a_time') {
      return {
        status: 'one_at_a_time',
        message:
          'Ya preparaste otra operación en esta misma respuesta: se hace UNA a la vez. Este pedido NO quedó preparado. Muestra el primer resumen, espera el "sí" y después prepara el siguiente.',
      };
    }
    return {
      status: 'retry',
      message:
        'Se preparó otra operación al mismo tiempo. NO se creó nada. Pídele al usuario que lo intente de nuevo.',
    };
  }

  /** Igual que `POST /sales`: avisa a los POS abiertos (y a Comandas) que hay un pedido nuevo. */
  private notifyTicketChanged(
    company_id: number,
    user_id: number,
    sale: { id: number; ticket_number: string },
  ): void {
    // Cada aviso por separado y best-effort: el pedido ya hizo commit.
    const emit = (event: string, send: () => void): void => {
      try {
        send();
      } catch (error) {
        this.logger.warn(
          `Fallo emitiendo ${event} (pedido ${sale.id}, company ${company_id}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    emit('ticket:changed', () =>
      this.realtimeGateway.emitTicketChanged(company_id, user_id, {
        invoiceId: sale.id,
        ticketNumber: sale.ticket_number,
      }),
    );
    // Modo restaurante: el pedido nuevo entra a Comandas (cocina lo ve ya).
    emit('comandas:changed', () => this.realtimeGateway.emitComandasChanged(company_id));
  }

  private unavailable(): Record<string, unknown> {
    return {
      status: 'unavailable',
      message: 'Esta operación no está disponible en este momento. NO se creó nada.',
    };
  }
}
