import { randomUUID } from 'node:crypto';

import { HttpException, Injectable, Logger } from '@nestjs/common';
import Big from 'big.js';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber } from '@/common/utils/precision';
import { CreatePurchaseAction } from '@/modules/purchases/actions/create-purchase.action';
import { CreatePurchaseDto } from '@/modules/purchases/dto/create-purchase.dto';

import {
  hashMessage,
  normalizeText,
  PENDING_ACTION_TTL_MINUTES,
  readMoneyArg,
  type AiToolRequestContext,
} from '../internal/expense-tool-helpers';
import {
  LOCK_PENDING_ACTION_SQL,
  MARK_PENDING_EXECUTED_SQL,
  MARK_PENDING_EXPIRED_SQL,
  UPSERT_PENDING_ACTION_SQL,
} from '../internal/expense-tool-sql';
import {
  checkPendingConfirmation,
  wrongOperationResult,
  type PendingActionType,
} from '../internal/pending-confirmation';
import {
  classifyDocumentMatch,
  computePurchaseLine,
  computePurchaseTotals,
  costDeviationWarning,
  documentTotalWarning,
  findByExactName,
  queriesOf,
  readDocumentItemsArg,
  readInvoiceNumberArg,
  readPurchaseLinesArg,
  resolveSupplier,
  type DocumentItemRequest,
  type DocumentMatch,
  type PurchaseLineAmounts,
  type PurchaseLineRequest,
  type PurchaseTotals,
  type SupplierResolution,
  type SupplierRow,
} from '../internal/purchase-tool-helpers';
import {
  ACTIVE_SUPPLIERS_SQL,
  buildDocumentDetailsSql,
  buildDocumentPoolSql,
  DOCUMENT_POOL_LIMIT,
  type DocumentScope,
} from '../internal/purchase-tool-sql';
import { buildCandidatePatterns, matchLine } from '../internal/sale-product-matching';
import { readString } from '../internal/tool-args';
import type { AiToolActor } from '../internal/tool-catalog';

/** Producto del pool (liviano) que entiende el motor de coincidencias. */
interface PoolProduct {
  id: number;
  name: string;
  sku_code: string | null;
  bar_code: string | null;
  packaging_name: string | null;
}

/** Detalle de un producto para mostrarlo o comprarlo. */
interface ProductDetail {
  id: number;
  name: string;
  sku_code: string | null;
  bar_code: string | null;
  product_type: string;
  stock: string | null;
  cost: string | null;
  packaging_id: string | null;
  packaging_name: string | null;
  packaging_value: string | null;
  parent_name: string | null;
  sale_price: string | null;
  last_unit_cost: string | null;
}

/** Línea ya resuelta, tal como queda en el snapshot pendiente. */
interface SnapshotLine extends PurchaseLineAmounts {
  product_id: number;
  name: string;
  sku_code: string | null;
  packaging_id: number | null;
  packaging_name: string | null;
  packaging_value: string;
  source_description: string;
  /** Costo de la última compra por la MISMA unidad (paquete), si hubo. */
  last_cost: string | null;
}

interface ExcludedItem {
  description: string;
  reason: string;
}

/** Lo que se guarda en `ai_pending_actions.payload` y se ejecuta con el "sí". */
interface PurchasePayload {
  operation_id: string;
  supplier_id: number;
  supplier_name: string;
  supplier_document: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  lines: SnapshotLine[];
  excluded: ExcludedItem[];
  warnings: string[];
  totals: PurchaseTotals;
}

interface PendingRow {
  id: string;
  action_type: PendingActionType;
  payload: PurchasePayload;
  request_id: string;
  trigger_message_hash: string;
  is_expired: boolean;
}

const money = (value: string | number | null): number => preciseNumber(value ?? 0, 2);
const qty = (value: string | number | null): number => preciseNumber(value ?? 0, 4);
const bigOrNull = (value: string | null): Big | null => {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return new Big(value);
  } catch {
    return null;
  }
};

const EXCLUDED_NOT_FOUND = 'No está en tu inventario (créalo en Inventario si quieres incluirlo).';
const EXCLUDED_BY_USER = 'Indicaste que no es ninguno de los productos de tu inventario.';

/** Primer mensaje de cada error de validación (anidados incluidos). */
const describeViolations = (violations: readonly ValidationError[]): string =>
  violations
    .flatMap((violation) => [
      ...Object.values(violation.constraints ?? {}),
      ...(violation.children ?? []).flatMap((child) =>
        describeViolations([child]).split('. ').filter(Boolean),
      ),
    ])
    .slice(0, 3)
    .join('. ');

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

/** Fecha de factura: YYYY-MM-DD real (o ausente). */
const readInvoiceDate = (raw: unknown): { ok: true; value: string | null } | { ok: false } => {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    return { ok: false };
  }
  const value = raw.trim();
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? { ok: false }
    : { ok: true, value };
};

/**
 * Herramientas de DOCUMENTOS y COMPRAS de Place: el usuario adjunta la factura
 * de un proveedor (foto o PDF) y Place
 *
 *   - `match_document_products`: cruza sus ítems con el inventario (¿existe?,
 *     ¿cuánto stock?, ¿a cuánto lo vendo?). Solo lectura.
 *   - `prepare_purchase` → `confirm_purchase`: la registra como COMPRA, con el
 *     mismo flujo de dos turnos que gastos y pedidos. Antes de preparar nada,
 *     verifica que cada ítem exista: lo parecido se le pregunta al usuario
 *     ("Encontré X, ¿es el mismo producto?") y lo que no existe se excluye.
 *     La compra se crea con `CreatePurchaseAction.runInTransaction` (misma
 *     lógica que `POST /purchases`) junto con la marca EXECUTED: exactly-once.
 *
 * La compra nace PENDIENTE de recibir (no suma stock hasta recibirla en
 * Compras) y suma su total a la deuda con el proveedor, como en la app.
 */
@Injectable()
export class RunAiPurchaseToolAction {
  private readonly logger = new Logger(RunAiPurchaseToolAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly createPurchase: CreatePurchaseAction,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // match_document_products
  // ────────────────────────────────────────────────────────────────────────

  async matchDocumentProducts(
    company_id: number,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const items = readDocumentItemsArg(args);
    if (items.status === 'missing') {
      return {
        error:
          'Faltan los ítems del documento. Lee el archivo y manda TODOS sus productos en "items".',
      };
    }
    if (items.status === 'invalid') {
      return { error: items.reason };
    }

    const pools = await this.fetchPools('inventory', company_id, items.items, []);
    const matches = items.items.map((item, index) =>
      classifyDocumentMatch(matchLine(queriesOf(item), pools[index], null), queriesOf(item)),
    );
    const details = await this.fetchDetails(
      this.dataSource.manager,
      'inventory',
      company_id,
      this.idsOf(matches),
    );

    let found = 0;
    let possible = 0;
    const views = items.items.map((item, index) => {
      const match = matches[index];
      if (match.status === 'found') {
        found += 1;
        const detail = details.get(match.product.id);
        return {
          position: item.position,
          description: item.description,
          status: 'found',
          product: detail ? this.describeProduct(detail) : { name: match.product.name },
        };
      }
      if (match.status === 'possible_match') {
        possible += 1;
        return {
          position: item.position,
          description: item.description,
          status: 'possible_match',
          candidates: match.candidates.map((candidate) => {
            const detail = details.get(candidate.id);
            return detail ? this.describeProduct(detail) : { name: candidate.name };
          }),
        };
      }
      return { position: item.position, description: item.description, status: 'not_found' };
    });

    return {
      count: items.items.length,
      found,
      possible_matches: possible,
      not_found: items.items.length - found - possible,
      items: views,
      message:
        'Responde SOLO lo que el usuario pidió (p. ej. el stock de cada ítem). "found" = está en el inventario. "possible_match" = NO es seguro: di "Encontré «X» en tu inventario, ¿es el mismo producto que «Y» del documento?" y nunca lo presentes como confirmado. "not_found" = no existe en el inventario.',
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // prepare_purchase
  // ────────────────────────────────────────────────────────────────────────

  async preparePurchase(
    company_id: number,
    actor: AiToolActor,
    args: Record<string, unknown>,
    context: AiToolRequestContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (!context?.current_user_message) {
      return this.unavailable();
    }

    const lines = readPurchaseLinesArg(args);
    if (lines.status === 'missing') {
      return {
        status: 'missing_data',
        missing: ['los productos de la factura con su cantidad y costo unitario'],
        message:
          'NO se preparó nada. Lee la factura y manda TODAS sus líneas; si no hay factura adjunta, pídesela al usuario.',
      };
    }
    if (lines.status === 'invalid') {
      return {
        status: 'invalid_data',
        invalid: [lines.reason],
        message:
          'NO se preparó nada. Corrige el dato (o pregúntaselo al usuario) y vuelve a llamar.',
      };
    }

    const supplier_name = readString(args, 'supplier') ?? null;
    const supplier_document = readString(args, 'supplier_document') ?? null;
    if (supplier_name === null && supplier_document === null) {
      return {
        status: 'missing_data',
        missing: ['el proveedor'],
        message:
          'NO se preparó nada. Manda el proveedor tal como aparece en la factura (nombre y NIT si lo trae); si la factura no lo dice, pregúntaselo al usuario.',
      };
    }
    const invoice_date = readInvoiceDate(args.invoice_date);
    if (!invoice_date.ok) {
      return {
        status: 'invalid_data',
        invalid: ['La fecha de la factura debe tener formato YYYY-MM-DD.'],
        message: 'NO se preparó nada. Corrige la fecha y vuelve a llamar.',
      };
    }
    const document_total = readMoneyArg(args, 'document_total');
    if (document_total.status === 'invalid') {
      return {
        status: 'invalid_data',
        invalid: [`Total de la factura: ${document_total.reason}`],
        message: 'NO se preparó nada. Corrige el total y vuelve a llamar.',
      };
    }

    const to_match = lines.lines.filter((line) => !line.skip);
    const confirmed_names = to_match
      .map((line) => line.product)
      .filter((name): name is string => name !== null)
      .map(normalizeText);

    const [suppliers, pools] = await Promise.all([
      this.dataSource.query<SupplierRow[]>(ACTIVE_SUPPLIERS_SQL, [String(company_id)]),
      this.fetchPools('purchasable', company_id, to_match, confirmed_names),
    ]);
    const supplier = resolveSupplier(
      { name: supplier_name, document: supplier_document },
      suppliers,
    );

    const pool_of = new Map(to_match.map((line, index) => [line.position, pools[index]]));
    const matches = new Map<number, DocumentMatch<PoolProduct>>();
    for (const line of to_match) {
      matches.set(line.position, this.matchPurchaseLine(line, pool_of.get(line.position) ?? []));
    }
    const details = await this.fetchDetails(
      this.dataSource.manager,
      'purchasable',
      company_id,
      this.idsOf([...matches.values()]),
    );

    const excluded: ExcludedItem[] = [];
    const resolved: Array<{ line: PurchaseLineRequest; detail: ProductDetail }> = [];
    const pending_views: Array<Record<string, unknown>> = [];
    for (const line of lines.lines) {
      if (line.skip) {
        excluded.push({ description: line.description, reason: EXCLUDED_BY_USER });
        continue;
      }
      const match = matches.get(line.position) as DocumentMatch<PoolProduct>;
      if (match.status === 'not_found') {
        excluded.push({ description: line.description, reason: EXCLUDED_NOT_FOUND });
        continue;
      }
      if (match.status === 'possible_match') {
        pending_views.push({
          position: line.position,
          description: line.description,
          status: 'possible_match',
          candidates: match.candidates.map((candidate) => {
            const detail = details.get(candidate.id);
            return detail ? this.describeProduct(detail) : { name: candidate.name };
          }),
        });
        continue;
      }
      const detail = details.get(match.product.id);
      if (!detail) {
        excluded.push({ description: line.description, reason: EXCLUDED_NOT_FOUND });
        continue;
      }
      resolved.push({ line, detail });
    }

    if (supplier.status !== 'ok' || pending_views.length > 0) {
      return {
        status: 'needs_input',
        supplier: this.describeSupplier(supplier, supplier_name ?? supplier_document ?? ''),
        possible_matches: pending_views,
        found: resolved.map(({ line, detail }) => ({
          description: line.description,
          product: detail.name,
        })),
        excluded,
        message:
          'NO se preparó la compra: hay que verificar datos con el usuario ANTES de crearla. Por cada "possible_match" pregúntale: "Encontré «<nombre>» en tu inventario, ¿es el mismo producto que «<descripción>» de la factura?" (si hay varias opciones, lístalas). Si el proveedor no quedó claro, pregunta cuál es (o dile que lo cree en Proveedores si no existe). Menciona los excluidos. Cuando responda, vuelve a llamar prepare_purchase con TODAS las líneas: si confirmó, pon en "product" el NOMBRE EXACTO del producto del inventario; si dijo que no es ninguno, pon "skip": true; y en "supplier" el nombre exacto del proveedor elegido.',
      };
    }

    if (resolved.length === 0) {
      return {
        status: 'nothing_to_purchase',
        excluded,
        message:
          'NO se preparó la compra: ninguno de los productos de la factura está en el inventario. Díselo al usuario, con la lista de excluidos, y explícale que debe crearlos en Inventario antes de registrar la compra.',
      };
    }

    const snapshot_lines: SnapshotLine[] = resolved.map(({ line, detail }) => {
      const packaging_value = bigOrNull(detail.packaging_value) ?? new Big(1);
      const last_unit = bigOrNull(detail.last_unit_cost);
      const last_cost = last_unit === null ? null : last_unit.times(packaging_value).round(2);
      return {
        product_id: detail.id,
        name: detail.name,
        sku_code: detail.sku_code,
        packaging_id: detail.packaging_id === null ? null : Number(detail.packaging_id),
        packaging_name: detail.packaging_name,
        packaging_value: packaging_value.toString(),
        source_description: line.description,
        last_cost: last_cost === null ? null : last_cost.toString(),
        ...computePurchaseLine({
          quantity: line.quantity,
          unit_cost: line.unit_cost,
          iva_rate: line.iva_rate,
          packaging_value,
        }),
      };
    });

    const totals = computePurchaseTotals(
      resolved.map(({ line }) => ({
        quantity: line.quantity,
        unit_cost: line.unit_cost,
        iva_rate: line.iva_rate,
      })),
    );
    if (!new Big(totals.total).gt(0)) {
      return {
        status: 'invalid_data',
        invalid: ['El total de la compra debe ser mayor a cero.'],
        message: 'NO se preparó nada. Revisa cantidades y costos con el usuario.',
      };
    }

    const warnings: string[] = [];
    for (const line of snapshot_lines) {
      const warning = costDeviationWarning(
        line.name,
        new Big(line.packaging_price),
        bigOrNull(line.last_cost),
      );
      if (warning) {
        warnings.push(warning);
      }
    }
    const total_warning = documentTotalWarning(
      new Big(totals.total),
      document_total.status === 'ok' ? document_total.amount : null,
      excluded.length > 0,
    );
    if (total_warning) {
      warnings.push(total_warning);
    }
    if (excluded.length > 0) {
      warnings.push(
        `${excluded.length === 1 ? 'Un ítem de la factura no se incluye' : `${excluded.length} ítems de la factura no se incluyen`}: no están en tu inventario.`,
      );
    }

    const resolved_supplier = supplier.supplier;
    const payload: PurchasePayload = {
      operation_id: randomUUID(),
      supplier_id: Number(resolved_supplier.id),
      supplier_name: resolved_supplier.legal_name,
      supplier_document: resolved_supplier.doc_number,
      invoice_number: readInvoiceNumberArg(args.invoice_number),
      invoice_date: invoice_date.value,
      lines: snapshot_lines,
      excluded,
      warnings,
      totals,
    };

    const saved = await this.savePending(company_id, actor.userId, payload, context);
    if (saved !== 'saved') {
      return this.notSaved(saved);
    }

    return {
      status: 'confirmation_required',
      summary: this.buildSummary(payload),
      message:
        'AÚN NO está creada. El usuario YA ve la vista previa de la compra como una tarjeta con estos datos exactos: NO la repitas (ni tablas, ni productos, ni cifras). En una o dos frases: que la revise, menciona las advertencias y los excluidos si los hay, y pídele que responda "sí" para crearla. Si quiere cambiar algo, vuelve a llamar prepare_purchase con los datos nuevos.',
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // confirm_purchase
  // ────────────────────────────────────────────────────────────────────────

  async confirmPurchase(
    company_id: number,
    actor: AiToolActor,
    context: AiToolRequestContext | undefined,
  ): Promise<Record<string, unknown>> {
    if (!context?.current_user_message) {
      return this.unavailable();
    }
    const creator = { id: actor.userId, fullName: actor.full_name?.trim() || 'Usuario' };

    try {
      return await this.dataSource.transaction(async (manager) => {
        const [pending] = await manager.query<PendingRow[]>(LOCK_PENDING_ACTION_SQL, [
          String(company_id),
          String(actor.userId),
        ]);
        if (!pending) {
          return {
            status: 'no_pending_action',
            message:
              'No hay ninguna compra pendiente de confirmar. NO se creó nada. Si el usuario quiere registrarla, prepárala primero con prepare_purchase.',
          };
        }
        if (pending.action_type !== 'CREATE_PURCHASE') {
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
        const changed = await this.revalidate(manager, company_id, payload);
        if (changed) {
          await expire();
          return { status: 'changed', message: changed };
        }

        const dto: CreatePurchaseDto = {
          supplier_id: payload.supplier_id,
          notes: 'Registrada por Place a partir de la factura del proveedor.',
          lines: payload.lines.map((line) => ({
            product_id: line.product_id,
            name: line.name,
            packaging_id: line.packaging_id,
            packaging_name: line.packaging_name,
            packaging_value: Number(line.packaging_value),
            packaging_qty: Number(line.packaging_qty),
            unit_qty: Number(line.unit_qty),
            unit_price: Number(line.unit_price),
            packaging_price: Number(line.packaging_price),
            iva_rate: Number(line.iva_rate),
          })),
          invoice_number: payload.invoice_number,
          // Mediodía de Bogotá: la columna es `date` y una fecha sola ("2026-10-20")
          // se leería como medianoche UTC → el día ANTERIOR en Colombia.
          invoice_date: payload.invoice_date
            ? new Date(`${payload.invoice_date}T12:00:00-05:00`).toISOString()
            : null,
          client_operation_id: payload.operation_id,
        };

        // Mismas reglas del DTO que `POST /purchases`: la compra de Place no
        // se salta el ValidationPipe.
        const violations = await validate(plainToInstance(CreatePurchaseDto, dto));
        if (violations.length > 0) {
          await expire();
          return {
            status: 'failed',
            message: `NO se creó la compra: ${describeViolations(violations)}. Explícaselo al usuario.`,
          };
        }

        const { purchase } = await this.createPurchase.runInTransaction(
          manager,
          dto,
          company_id,
          creator,
        );
        await manager.query(MARK_PENDING_EXECUTED_SQL, [
          pending.id,
          String(company_id),
          String(purchase.id),
        ]);

        this.logger.log({
          event: 'ai.purchase.created',
          companyId: company_id,
          userId: actor.userId,
          pendingActionId: Number(pending.id),
          purchaseId: Number(purchase.id),
          purchaseNumber: purchase.purchase_number,
          total: purchase.total,
        });

        return {
          status: 'executed',
          purchase: {
            purchase_id: Number(purchase.id),
            purchase_number: purchase.purchase_number,
            supplier_name: purchase.supplier_name,
            lines_count: payload.lines.length,
            total: money(purchase.total),
            status: 'PENDING',
          },
          message:
            'Compra creada. El usuario ya ve la tarjeta con el número y el total. Confírmaselo en una frase, sin repetir la factura: queda PENDIENTE DE RECIBIR en Compras (el stock entra al recibirla) y su total suma a la deuda con el proveedor.',
        };
      });
    } catch (error) {
      // Rollback completo: ni compra, ni pendiente ejecutada.
      if (error instanceof HttpException) {
        return {
          status: 'failed',
          message: `NO se creó la compra: ${httpErrorMessage(error)}. Explícaselo al usuario.`,
        };
      }
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Resolución
  // ────────────────────────────────────────────────────────────────────────

  /** Línea de compra: primero lo que el usuario confirmó por nombre exacto. */
  private matchPurchaseLine(
    line: PurchaseLineRequest,
    pool: readonly PoolProduct[],
  ): DocumentMatch<PoolProduct> {
    if (line.product !== null) {
      const exact = findByExactName(pool, line.product);
      if (exact !== null && exact !== 'ambiguous') {
        return { status: 'found', product: exact, via: 'confirmed' };
      }
      const queries = [line.product, ...queriesOf(line)];
      return classifyDocumentMatch(matchLine(queries, pool, null), queries);
    }
    return classifyDocumentMatch(matchLine(queriesOf(line), pool, null), queriesOf(line));
  }

  /**
   * Pool de candidatos de cada ítem: UNA consulta para todo el documento; si se
   * llena el tope, cada ítem trae el suyo (en paralelo) para que ninguno quede
   * fuera por culpa de los demás.
   */
  private async fetchPools(
    scope: DocumentScope,
    company_id: number,
    items: readonly DocumentItemRequest[],
    names: readonly string[],
  ): Promise<PoolProduct[][]> {
    if (items.length === 0) {
      return [];
    }
    const combined = await this.queryPool(scope, company_id, items, names);
    if (combined.length < DOCUMENT_POOL_LIMIT) {
      return items.map(() => combined);
    }
    return Promise.all(
      items.map((item) => {
        const own =
          'product' in item && typeof item.product === 'string'
            ? [normalizeText(item.product)]
            : [];
        return this.queryPool(scope, company_id, [item], own);
      }),
    );
  }

  private queryPool(
    scope: DocumentScope,
    company_id: number,
    items: readonly DocumentItemRequest[],
    names: readonly string[],
  ): Promise<PoolProduct[]> {
    const queries = items.flatMap((item) => [
      ...queriesOf(item),
      ...('product' in item && typeof item.product === 'string' ? [item.product] : []),
    ]);
    const codes = [
      ...new Set(
        items
          .flatMap((item) => [item.code, item.description])
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim().toLowerCase())
          .filter((value) => value.length > 0 && value.length <= 64),
      ),
    ];
    const { sql, params } = buildDocumentPoolSql(scope, company_id, {
      patterns: buildCandidatePatterns(queries),
      codes,
      names: [...new Set(names)],
    });
    return this.dataSource.query<PoolProduct[]>(sql, params);
  }

  private idsOf(matches: ReadonlyArray<DocumentMatch<PoolProduct>>): number[] {
    const ids = new Set<number>();
    for (const match of matches) {
      if (match.status === 'found') {
        ids.add(match.product.id);
      } else if (match.status === 'possible_match') {
        for (const candidate of match.candidates) {
          ids.add(candidate.id);
        }
      }
    }
    return [...ids];
  }

  private async fetchDetails(
    manager: EntityManager,
    scope: DocumentScope,
    company_id: number,
    ids: readonly number[],
  ): Promise<Map<number, ProductDetail>> {
    if (ids.length === 0) {
      return new Map();
    }
    const { sql, params } = buildDocumentDetailsSql(scope, company_id, ids);
    const rows = await manager.query<ProductDetail[]>(sql, params);
    return new Map(rows.map((row) => [Number(row.id), { ...row, id: Number(row.id) }]));
  }

  private describeProduct(detail: ProductDetail): Record<string, unknown> {
    return {
      name: detail.name,
      sku: detail.sku_code,
      barcode: detail.bar_code,
      packaging: detail.packaging_name,
      parent: detail.parent_name,
      stock: qty(detail.stock),
      cost: money(detail.cost),
      sale_price: detail.sale_price === null ? null : money(detail.sale_price),
    };
  }

  private describeSupplier(resolution: SupplierResolution, asked: string): Record<string, unknown> {
    if (resolution.status === 'ok') {
      return {
        status: 'ok',
        name: resolution.supplier.legal_name,
        document: resolution.supplier.doc_number,
      };
    }
    if (resolution.status === 'possible_match') {
      return {
        status: 'possible_match',
        asked,
        candidates: resolution.candidates.map((candidate) => ({
          name: candidate.legal_name,
          document: candidate.doc_number,
        })),
      };
    }
    return {
      status: 'not_found',
      asked,
      message: 'No existe entre los proveedores activos: el usuario debe crearlo en Proveedores.',
    };
  }

  /** Vista previa para la tarjeta: los datos EXACTOS del snapshot. */
  private buildSummary(payload: PurchasePayload): Record<string, unknown> {
    return {
      supplier: { name: payload.supplier_name, document: payload.supplier_document },
      invoice_reference: payload.invoice_number,
      lines: payload.lines.map((line) => ({
        product_name: line.name,
        sku_code: line.sku_code,
        packaging_name: line.packaging_name,
        packaging_value: qty(line.packaging_value),
        quantity: qty(line.packaging_qty),
        unit_cost: money(line.packaging_price),
        iva_rate: money(line.iva_rate),
        subtotal: money(line.subtotal),
        iva_amount: money(line.iva_amount),
        total: money(line.total),
        source_description: line.source_description,
        last_cost: line.last_cost === null ? null : money(line.last_cost),
      })),
      excluded: payload.excluded,
      warnings: payload.warnings,
      subtotal: money(payload.totals.subtotal),
      iva_total: money(payload.totals.iva_total),
      total: money(payload.totals.total),
      expires_at: new Date(Date.now() + PENDING_ACTION_TTL_MINUTES * 60_000).toISOString(),
    };
  }

  /**
   * Dentro de la transacción, antes de crear: el proveedor sigue activo y cada
   * producto sigue siendo comprable con el MISMO empaque que vio el usuario
   * (si cambió, las unidades que entrarían ya no son las de la vista previa).
   * `null` = todo igual.
   */
  private async revalidate(
    manager: EntityManager,
    company_id: number,
    payload: PurchasePayload,
  ): Promise<string | null> {
    const [suppliers, details] = await Promise.all([
      manager.query<SupplierRow[]>(ACTIVE_SUPPLIERS_SQL, [String(company_id)]),
      this.fetchDetails(
        manager,
        'purchasable',
        company_id,
        payload.lines.map((line) => line.product_id),
      ),
    ]);
    if (!suppliers.some((supplier) => Number(supplier.id) === payload.supplier_id)) {
      return `El proveedor «${payload.supplier_name}» ya no está activo. NO se creó la compra: díselo al usuario.`;
    }
    for (const line of payload.lines) {
      const detail = details.get(line.product_id);
      if (!detail) {
        return `El producto «${line.name}» ya no se puede comprar (se archivó o cambió). NO se creó la compra: prepárala de nuevo.`;
      }
      const current_packaging = detail.packaging_id === null ? null : Number(detail.packaging_id);
      const current_value = bigOrNull(detail.packaging_value) ?? new Big(1);
      if (current_packaging !== line.packaging_id || !current_value.eq(line.packaging_value)) {
        return `El empaque de «${line.name}» cambió desde la vista previa. NO se creó la compra: prepárala de nuevo para que el usuario vea las unidades correctas.`;
      }
    }
    return null;
  }

  private async savePending(
    company_id: number,
    user_id: number,
    payload: PurchasePayload,
    context: AiToolRequestContext,
  ): Promise<'saved' | 'one_at_a_time' | 'concurrent'> {
    try {
      const rows = await this.dataSource.query<Array<{ id: string }>>(UPSERT_PENDING_ACTION_SQL, [
        String(company_id),
        String(user_id),
        'CREATE_PURCHASE',
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
          'Ya preparaste otra operación en esta misma respuesta: se hace UNA a la vez. Esta compra NO quedó preparada. Muestra el primer resumen, espera el "sí" y después prepara la siguiente.',
      };
    }
    return {
      status: 'retry',
      message:
        'Se preparó otra operación al mismo tiempo. NO se creó nada. Pídele al usuario que lo intente de nuevo.',
    };
  }

  private unavailable(): Record<string, unknown> {
    return {
      status: 'unavailable',
      message: 'Esta operación no está disponible en este momento. NO se creó nada.',
    };
  }
}
