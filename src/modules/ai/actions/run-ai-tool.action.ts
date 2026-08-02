import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';
import { preciseNumber } from '@/common/utils/precision';
import { DashboardService } from '@/modules/dashboard/dashboard.service';
import { accessibleProductsPredicate } from '@/modules/products/internal/accessible-products.helper';
import { parseUtcRange, todayUtcDate } from '@/modules/reports/internal/range';
import { TreasuryService } from '@/modules/treasury/treasury.service';

import { readDate, readDateRange, readInt, readNumber, readString } from '../internal/tool-args';
import {
  buildCustomerDebtSubquery,
  buildDebtorTotalsSql,
  buildTopDebtorsSql,
} from '../internal/tool-sql';
import {
  findTool,
  isToolAllowed,
  salesScopeUserId,
  stripProfitFields,
  type AiToolActor,
} from '../internal/tool-catalog';

/** Resultado de ejecutar una herramienta pedida por el modelo. */
export interface AiToolExecution {
  name: string;
  label: string;
  ok: boolean;
  /** Lo que se le devuelve al modelo como `functionResponse.response`. */
  response: Record<string, unknown>;
  /** Milisegundos que tardó — solo para el log. */
  durationMs: number;
}

const num = (value: unknown): number => preciseNumber(value ?? 0, 2);
const qty = (value: unknown): number => preciseNumber(value ?? 0, 4);

/**
 * Ejecuta las herramientas de PlacePOS IA contra la base de datos del tenant.
 *
 * Invariantes:
 *   - SOLO lectura. Ninguna herramienta muta datos.
 *   - TODA query filtra por `company_id` (multi-tenant estricto).
 *   - Se revalida el permiso antes de ejecutar: que el modelo "invente" una
 *     llamada a una herramienta que no le declaramos no basta para ejecutarla.
 *   - Nunca lanza: un fallo se devuelve como `{ error }` para que el modelo
 *     pueda explicárselo al usuario en vez de tumbar el stream.
 */
@Injectable()
export class RunAiToolAction {
  private readonly logger = new Logger(RunAiToolAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly dashboardService: DashboardService,
    private readonly treasuryService: TreasuryService,
  ) {}

  async execute(
    companyId: number,
    actor: AiToolActor,
    name: string,
    args: Record<string, unknown>,
  ): Promise<AiToolExecution> {
    const startedAt = Date.now();
    const tool = findTool(name);

    if (!tool) {
      return {
        name,
        label: name,
        ok: false,
        response: { error: `La herramienta "${name}" no existe.` },
        durationMs: Date.now() - startedAt,
      };
    }

    if (!isToolAllowed(tool, actor)) {
      return {
        name,
        label: tool.label,
        ok: false,
        response: {
          error:
            'El usuario no tiene permiso para consultar esta información. Explícale que su rol no incluye ese módulo.',
        },
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const raw = await this.dispatch(companyId, actor, tool.name, args ?? {});
      const response = stripProfitFields(raw, actor.canViewProfit);
      return {
        name: tool.name,
        label: tool.label,
        ok: true,
        response,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.logger.error(
        { err: error, tool: tool.name, companyId },
        'Fallo ejecutando herramienta de IA',
      );
      return {
        name: tool.name,
        label: tool.label,
        ok: false,
        response: {
          error:
            'No se pudo consultar esa información en este momento. Dile al usuario que lo intente de nuevo.',
        },
        durationMs: Date.now() - startedAt,
      };
    }
  }

  private dispatch(
    companyId: number,
    actor: AiToolActor,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case 'get_daily_summary':
        return this.dailySummary(companyId, args);
      case 'list_sales':
        return this.listSales(companyId, actor, args);
      case 'get_performance_range':
        return this.performanceRange(companyId, args);
      case 'get_top_products':
        return this.topProducts(companyId, args);
      case 'search_products':
        return this.searchProducts(companyId, args);
      case 'get_low_stock':
        return this.lowStock(companyId, args);
      case 'get_debtors':
        return this.debtors(companyId, args);
      case 'search_customers':
        return this.searchCustomers(companyId, args);
      case 'get_expenses_summary':
        return this.expensesSummary(companyId, args);
      case 'get_treasury_accounts':
        return this.treasuryAccounts(companyId);
      default:
        return Promise.resolve({ error: `La herramienta "${name}" no está implementada.` });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Herramientas que reutilizan la maquinaria financiera ya canónica
  // ────────────────────────────────────────────────────────────────────────

  private async dailySummary(
    companyId: number,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const date = readDate(args, 'date') ?? todayUtcDate();
    const summary = await this.dashboardService.today(companyId, date);

    return {
      date: summary.date,
      collected: {
        cashSales: summary.cashSales,
        transferSales: summary.transferSales,
        creditPaymentsCash: summary.creditPaymentsCash,
        creditPaymentsTransfer: summary.creditPaymentsTransfer,
        total: summary.totalCollected,
      },
      sales: {
        count: summary.salesCount,
        cash: summary.cashSales,
        transfer: summary.transferSales,
        credit: summary.creditSales,
        orders: summary.ordersTotal,
        total: summary.totalSales,
      },
      profit: summary.salesProfit,
      surplus: summary.salesSurplus,
      expenses: summary.expenses,
      realProfit: summary.salesRealProfit,
      newCredits: summary.newCredits,
      purchases: summary.purchases,
      cashBalances: summary.cashAccounts.totals,
      note: 'Los montos están en pesos colombianos. "collected.total" es el dinero real que entró hoy; "sales.total" incluye las ventas a crédito aunque no se hayan cobrado.',
    };
  }

  /**
   * Ventas del día una por una, con cliente y productos.
   *
   * Mismo criterio de fecha que el resumen y los informes
   * (`COALESCE(sold_at, created_at)`, solo `SALE` no borradas), para que el
   * detalle cuadre con los totales que da `get_daily_summary`.
   *
   * Alcance: un empleado sin `canViewAllSales` solo ve SUS ventas, igual que en
   * el informe de ventas.
   */
  private async listSales(
    companyId: number,
    actor: AiToolActor,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const date = readDate(args, 'date') ?? todayUtcDate();
    const limit = readInt(args, 'limit', 20, 1, 50);
    const customer = readString(args, 'customer');
    const range = parseUtcRange(date, date);
    const scopeUserId = salesScopeUserId(actor);

    const params: unknown[] = [String(companyId), range.dateStart, range.dateEnd];
    const filters: string[] = [];

    if (scopeUserId !== null) {
      params.push(String(scopeUserId));
      filters.push(`si.created_by_id = $${params.length}`);
    }
    if (customer) {
      params.push(`%${customer.toLowerCase()}%`);
      filters.push(`LOWER(COALESCE(c.name, si.customer_name, '')) LIKE $${params.length}`);
    }
    params.push(limit);
    const limitIdx = `$${params.length}`;

    const rows = await this.dataSource.query<
      Array<{
        number: string;
        sold_at: Date;
        total: string;
        profit: string;
        customer: string | null;
        cashier: string | null;
        credit_balance: string | null;
        credit_status: string | null;
        notes_count: string;
        payment_methods: string[] | null;
        items: Array<{
          description: string;
          quantity: string;
          unit_price: string;
          total: string;
        }> | null;
      }>
    >(
      `
      SELECT
        COALESCE(si.sale_number, si.ticket_number)   AS number,
        COALESCE(si.sold_at, si.created_at)          AS sold_at,
        si.total                                     AS total,
        si.profit                                    AS profit,
        COALESCE(c.name, si.customer_name)           AS customer,
        si.created_by                                AS cashier,
        sc.balance                                   AS credit_balance,
        sc.status::text                              AS credit_status,
        (
          SELECT COUNT(*) FROM credit_notes n
          WHERE n.sale_invoice_id = si.id AND n.company_id = si.company_id AND n.is_deleted = false
        ) AS notes_count,
        (
          SELECT jsonb_agg(DISTINCT p.payment_method::text)
          FROM sale_payments p
          WHERE p.sale_invoice_id = si.id AND p.company_id = si.company_id AND p.is_voided = false
        ) AS payment_methods,
        (
          SELECT jsonb_agg(jsonb_build_object(
            'description', l.description,
            'quantity',    l.quantity,
            'unit_price',  l.unit_price,
            'total',       l.total
          ) ORDER BY l.id)
          FROM sale_invoice_lines l
          WHERE l.sale_invoice_id = si.id AND l.company_id = si.company_id
        ) AS items
      FROM sale_invoices si
      LEFT JOIN customers c ON c.id = si.customer_id AND c.company_id = si.company_id
      LEFT JOIN sale_credits sc ON sc.sale_invoice_id = si.id AND sc.company_id = si.company_id
      WHERE si.company_id = $1
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
        AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
        ${filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY COALESCE(si.sold_at, si.created_at) DESC
      LIMIT ${limitIdx}
      `,
      params,
    );

    const sales = rows.map((row) => ({
      number: row.number,
      time: dayjs(row.sold_at).tz(APP_TIMEZONE).format('HH:mm'),
      // Sin cliente asociado la venta fue de mostrador: hay que decirlo así,
      // no inventarle un nombre.
      customer: row.customer?.trim() || 'Mostrador (sin cliente)',
      cashier: row.cashier,
      total: num(row.total),
      profit: num(row.profit),
      paymentMethods: row.payment_methods ?? [],
      isCredit: row.credit_status !== null,
      pendingBalance: row.credit_balance !== null ? num(row.credit_balance) : 0,
      hasAdjustmentNotes: Number(row.notes_count) > 0,
      items: (row.items ?? []).map((item) => ({
        product: item.description,
        quantity: qty(item.quantity),
        unitPrice: num(item.unit_price),
        total: num(item.total),
      })),
    }));

    return {
      date,
      count: sales.length,
      limit,
      scope:
        scopeUserId === null ? 'todas las ventas del negocio' : 'solo las ventas de este usuario',
      sales,
      note: 'Si "customer" dice "Mostrador (sin cliente)" la venta se registró sin asociar cliente: NO le atribuyas un nombre. "hasAdjustmentNotes" indica que el ticket tiene notas crédito/débito, así que su total pudo cambiar.',
    };
  }

  private async performanceRange(
    companyId: number,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { from, to } = readDateRange(args, todayUtcDate());
    const performance = await this.dashboardService.performance(companyId, from, to);

    // La serie completa puede ser enorme (hasta 366 puntos): recortamos a los
    // últimos 62 días para no inflar el prompt, avisando al modelo del recorte.
    const MAX_POINTS = 62;
    const series = performance.series.slice(-MAX_POINTS);

    return {
      from: performance.from,
      to: performance.to,
      totals: performance.totals,
      series,
      seriesTruncated: performance.series.length > series.length,
      totalDays: performance.series.length,
    };
  }

  private async topProducts(
    companyId: number,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const limit = readInt(args, 'limit', 10, 1, 50);
    const products = await this.dashboardService.topProducts(companyId, limit);
    return { limit, products };
  }

  private async treasuryAccounts(companyId: number): Promise<Record<string, unknown>> {
    const accounts = await this.treasuryService.accounts(companyId);
    return {
      cashRegisters: accounts.cashRegisters,
      banks: accounts.banks.map((bank) => ({
        name: bank.name,
        accountNumber: bank.accountNumber,
        balance: bank.balance,
      })),
      wallets: accounts.wallets,
      totals: accounts.totals,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Herramientas con SQL propio (lecturas simples, siempre por company_id)
  // ────────────────────────────────────────────────────────────────────────

  private async searchProducts(
    companyId: number,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const query = readString(args, 'query');
    if (!query) {
      return { error: 'Falta el texto de búsqueda.' };
    }
    const limit = readInt(args, 'limit', 10, 1, 25);

    // Visibilidad = productos propios + los compartidos por la sucursal principal.
    const access = accessibleProductsPredicate('p', companyId, 1);
    const params: unknown[] = [...access.params, `%${query.toLowerCase()}%`, limit];
    const searchIdx = `$${access.params.length + 1}`;
    const limitIdx = `$${access.params.length + 2}`;

    const rows = await this.dataSource.query<
      Array<{
        name: string;
        sku_code: string | null;
        bar_code: string | null;
        product_type: string;
        stock: string;
        cost: string;
        category: string | null;
        packaging: string | null;
        parent_name: string | null;
        prices: Array<{ name: string; sale_price: string; margin: string }> | null;
      }>
    >(
      `
      SELECT
        p.name,
        p.sku_code,
        p.bar_code,
        p.product_type,
        p.stock,
        p.cost,
        cat.name  AS category,
        pk.name   AS packaging,
        parent.name AS parent_name,
        (
          SELECT jsonb_agg(jsonb_build_object(
            'name', pp.name, 'sale_price', pp.sale_price, 'margin', pp.margin
          ) ORDER BY pp.sale_price)
          FROM product_prices pp
          WHERE pp.product_id = p.id
        ) AS prices
      FROM products p
      LEFT JOIN categories cat ON cat.id = p.category_id
      LEFT JOIN packagings pk ON pk.id = p.packaging_id
      LEFT JOIN products parent ON parent.id = p.parent_id
      WHERE ${access.sql}
        AND p.is_archived = false
        AND (
          LOWER(p.name) LIKE ${searchIdx}
          OR LOWER(COALESCE(p.sku_code, '')) LIKE ${searchIdx}
          OR LOWER(COALESCE(p.bar_code, '')) LIKE ${searchIdx}
        )
      ORDER BY p.name ASC
      LIMIT ${limitIdx}
      `,
      params,
    );

    return {
      query,
      count: rows.length,
      products: rows.map((row) => ({
        name: row.name,
        sku: row.sku_code,
        barcode: row.bar_code,
        type: row.product_type,
        parent: row.parent_name,
        category: row.category,
        packaging: row.packaging,
        stock: qty(row.stock),
        cost: num(row.cost),
        prices: (row.prices ?? []).map((price) => ({
          name: price.name,
          salePrice: num(price.sale_price),
          margin: preciseNumber(price.margin ?? 0, 2),
        })),
      })),
    };
  }

  private async lowStock(
    companyId: number,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const threshold = readNumber(args, 'threshold', 5, 0, 1_000_000);
    const limit = readInt(args, 'limit', 20, 1, 50);

    // Mismo alcance que la búsqueda de inventario: incluye lo que la sucursal
    // principal comparte con esta company. Si no, una sucursal vería su lista
    // de reposición vacía teniendo productos en cero.
    const params: unknown[] = [threshold, limit];
    const access = accessibleProductsPredicate('p', companyId, params.length + 1);
    params.push(...access.params);

    const rows = await this.dataSource.query<
      Array<{ name: string; sku_code: string | null; stock: string; cost: string }>
    >(
      `
      SELECT p.name, p.sku_code, p.stock, p.cost
      FROM products p
      WHERE ${access.sql}
        AND p.is_archived = false
        AND p.parent_id IS NULL
        AND p.stock <= $1
      ORDER BY p.stock ASC, p.name ASC
      LIMIT $2
      `,
      params,
    );

    return {
      threshold,
      count: rows.length,
      products: rows.map((row) => ({
        name: row.name,
        sku: row.sku_code,
        stock: qty(row.stock),
        cost: num(row.cost),
      })),
      note: 'Solo se listan productos base (no presentaciones), que son los que se reponen con una compra.',
    };
  }

  private async debtors(
    companyId: number,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const limit = readInt(args, 'limit', 10, 1, 50);

    const [totals] = await this.dataSource.query<
      Array<{ total_balance: string; credits_count: string; customers_count: string }>
    >(buildDebtorTotalsSql(), [String(companyId)]);

    const rows = await this.dataSource.query<
      Array<{
        name: string;
        phone: string | null;
        balance: string;
        credits: string;
        oldest_date: Date | null;
      }>
    >(buildTopDebtorsSql(), [String(companyId), limit]);

    const today = todayUtcDate();
    return {
      totalReceivable: num(totals?.total_balance),
      openCredits: Number(totals?.credits_count ?? 0),
      customersWithDebt: Number(totals?.customers_count ?? 0),
      topDebtors: rows.map((row) => ({
        name: row.name,
        phone: row.phone,
        balance: num(row.balance),
        credits: Number(row.credits),
        oldestCreditDate: row.oldest_date ? row.oldest_date.toISOString().slice(0, 10) : null,
        daysSinceOldest: row.oldest_date
          ? Math.max(
              0,
              Math.floor(
                (Date.parse(`${today}T00:00:00Z`) -
                  Date.parse(`${row.oldest_date.toISOString().slice(0, 10)}T00:00:00Z`)) /
                  86_400_000,
              ),
            )
          : null,
      })),
      // El modelo tiende a sumar la lista visible y presentarla como el total.
      // Se lo decimos explícitamente, porque la lista viene recortada.
      listedDebtors: rows.length,
      note: `"totalReceivable" es la cartera COMPLETA (${Number(totals?.credits_count ?? 0)} créditos de ${Number(totals?.customers_count ?? 0)} clientes) y cuadra con Informes → Cartera. "topDebtors" son solo los ${rows.length} de mayor saldo: NO los sumes para deducir el total. Solo cuenta lo pendiente de ventas vigentes; las ventas anuladas no hacen cartera.`,
    };
  }

  private async searchCustomers(
    companyId: number,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const query = readString(args, 'query');
    if (!query) {
      return { error: 'Falta el texto de búsqueda.' };
    }
    const limit = readInt(args, 'limit', 10, 1, 25);

    const rows = await this.dataSource.query<
      Array<{
        name: string;
        doc_number: string | null;
        phone: string | null;
        balance: string;
        advance_balance: string;
        points: string;
        last_sale: Date | null;
        sales_count: string;
      }>
    >(
      `
      SELECT
        c.name,
        c.doc_number,
        c.phone,
        ${buildCustomerDebtSubquery('$1')} AS balance,
        c.advance_balance,
        c.points,
        (
          SELECT MAX(si.created_at) FROM sale_invoices si
          WHERE si.customer_id = c.id AND si.company_id = c.company_id AND si.is_deleted = false
        ) AS last_sale,
        (
          SELECT COUNT(*) FROM sale_invoices si
          WHERE si.customer_id = c.id AND si.company_id = c.company_id AND si.is_deleted = false
        ) AS sales_count
      FROM customers c
      WHERE c.company_id = $1
        AND c.is_archived = false
        AND (
          LOWER(c.name) LIKE $2
          OR LOWER(COALESCE(c.doc_number, '')) LIKE $2
          OR LOWER(COALESCE(c.phone, '')) LIKE $2
          OR LOWER(COALESCE(c.email, '')) LIKE $2
        )
      ORDER BY c.name ASC
      LIMIT $3
      `,
      [String(companyId), `%${query.toLowerCase()}%`, limit],
    );

    return {
      query,
      count: rows.length,
      customers: rows.map((row) => ({
        name: row.name,
        document: row.doc_number,
        phone: row.phone,
        debt: num(row.balance),
        advanceBalance: num(row.advance_balance),
        points: preciseNumber(row.points ?? 0, 2),
        salesCount: Number(row.sales_count),
        lastPurchase: row.last_sale ? row.last_sale.toISOString().slice(0, 10) : null,
      })),
    };
  }

  private async expensesSummary(
    companyId: number,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { from, to } = readDateRange(args, todayUtcDate());
    // Mismo criterio que el módulo Gastos: se filtra por `expense_date` con los
    // límites del día COLOMBIANO convertidos al instante UTC.
    const range = parseUtcRange(from, to);

    const params = [String(companyId), range.dateStart, range.dateEnd];
    const dateFilter = `
      e.company_id = $1
      AND e.is_archived = false
      AND e.expense_date BETWEEN $2 AND $3
    `;

    const [totals] = await this.dataSource.query<
      Array<{ total: string; fixed_total: string; variable_total: string; count: string }>
    >(
      `
      SELECT
        COALESCE(SUM(e.amount), 0)                                        AS total,
        COALESCE(SUM(CASE WHEN e.is_fixed THEN e.amount ELSE 0 END), 0)   AS fixed_total,
        COALESCE(SUM(CASE WHEN e.is_fixed THEN 0 ELSE e.amount END), 0)   AS variable_total,
        COUNT(*)                                                          AS count
      FROM expenses e
      WHERE ${dateFilter}
      `,
      params,
    );

    const byCategory = await this.dataSource.query<
      Array<{ category: string | null; total: string }>
    >(
      `
      SELECT COALESCE(NULLIF(e.category, ''), 'Sin categoría') AS category, SUM(e.amount) AS total
      FROM expenses e
      WHERE ${dateFilter}
      GROUP BY 1
      ORDER BY SUM(e.amount) DESC
      LIMIT 15
      `,
      params,
    );

    const biggest = await this.dataSource.query<
      Array<{ description: string; amount: string; expense_date: Date; is_fixed: boolean }>
    >(
      `
      SELECT e.description, e.amount, e.expense_date, e.is_fixed
      FROM expenses e
      WHERE ${dateFilter}
      ORDER BY e.amount DESC
      LIMIT 10
      `,
      params,
    );

    return {
      from,
      to,
      total: num(totals?.total),
      fixedTotal: num(totals?.fixed_total),
      variableTotal: num(totals?.variable_total),
      count: Number(totals?.count ?? 0),
      byCategory: byCategory.map((row) => ({ category: row.category, total: num(row.total) })),
      biggest: biggest.map((row) => ({
        description: row.description,
        amount: num(row.amount),
        date: row.expense_date.toISOString().slice(0, 10),
        isFixed: row.is_fixed,
      })),
      note: 'Los gastos fijos NO se restan de la ganancia del día; solo bajan el saldo de su fuente. Los variables sí afectan la ganancia real.',
    };
  }
}
