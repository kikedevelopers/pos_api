import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import type { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import type { PermissionKey } from '@/modules/roles/internal/permission-catalog';

import { GetSalesReportAction } from '../actions/get-sales-report.action';

const OWNER: AuthUser = {
  user_id: 7,
  company_id: 42,
  name: 'Owner',
  lastname: 'Test',
  type: 'owner',
  account: 'user',
  scope: 'app',
};

const EMPLOYEE: AuthUser = {
  user_id: 9,
  company_id: 42,
  name: 'Empleado',
  lastname: 'Test',
  type: 'employee',
  account: 'user',
  scope: 'app',
};

/**
 * Tests unitarios de `GetSalesReportAction`.
 *
 * Foco: multi-tenancy en TODAS las subqueries (invoice principal + notas +
 * predicates de filtros). Si una rama de `applyNoteFilter` omitiera el
 * `company_id = $1` en su EXISTS, sería leak cross-tenant.
 */
describe('GetSalesReportAction', () => {
  let action: GetSalesReportAction;
  let querySpy: jest.Mock;
  // Permisos efectivos que devuelve el resolver para un EMPLEADO. owner/superadmin
  // siempre reciben `canViewAllSales` (acceso total). Configurable por test para
  // cubrir Vendedor (sin la key → solo sus ventas) y Cajero (con la key → todas).
  let employeeEffective: PermissionKey[];
  // Flag `include_orders_in_reports` de la company (default OFF).
  let includeOrders: boolean;

  beforeEach(() => {
    querySpy = jest.fn(() => Promise.resolve([]));
    employeeEffective = [];
    includeOrders = false;
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    const resolvePermissionsMock = {
      execute: jest.fn((actor: { type: string }) =>
        Promise.resolve(
          actor.type === 'owner' || actor.type === 'superadmin'
            ? (['canViewAllSales'] as PermissionKey[])
            : employeeEffective,
        ),
      ),
    } as unknown as ResolveEffectivePermissionsAction;
    const getIncludeOrdersMock = {
      execute: jest.fn(() => Promise.resolve({ enabled: includeOrders })),
    } as unknown as GetIncludeOrdersInReportsAction;
    action = new GetSalesReportAction(dataSourceMock, resolvePermissionsMock, getIncludeOrdersMock);
  });

  function allCalls(): Array<{ sql: string; params: unknown[] }> {
    return querySpy.mock.calls.map(([sql, params]: [string, unknown[]]) => ({ sql, params }));
  }

  it('400 si faltan dateFrom o dateTo', async () => {
    await expect(action.execute(42, { dateFrom: '2026-05-01' }, OWNER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(action.execute(42, { dateTo: '2026-05-31' }, OWNER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('multi-tenant: cada query filtra company_id en sale_invoices, sale_credits y credit_notes', async () => {
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' }, OWNER);
    const calls = allCalls();
    expect(calls.length).toBe(2); // invoice query + notes query.
    for (const c of calls) {
      expect(c.sql).toMatch(/si\.company_id\s*=\s*\$1/);
      expect(c.params[0]).toBe('42');
    }
    // El query principal debe filtrar el LEFT JOIN sale_credits por company_id.
    const invoiceCall = calls[0];
    expect(invoiceCall.sql).toMatch(/sc\.company_id\s*=\s*\$1/);
    // Sub-selects de credit_notes también filtran por company_id.
    expect(invoiceCall.sql).toMatch(/cn2\.company_id\s*=\s*\$1/);
  });

  it('noteFilter=FULL_VOID añade EXISTS con cn.company_id = $1', async () => {
    await action.execute(
      42,
      {
        dateFrom: '2026-05-01',
        dateTo: '2026-05-31',
        noteFilter: 'FULL_VOID',
      },
      OWNER,
    );
    const invoiceCall = allCalls()[0];
    expect(invoiceCall.sql).toMatch(/cn\.company_id\s*=\s*\$1/);
    expect(invoiceCall.sql).toMatch(/cn\.operation_type = 'FULL_VOID'/);
  });

  it('aislamiento cross-tenant: jamás emite filtro de company con placeholder distinto a $1', async () => {
    await action.execute(
      42,
      {
        dateFrom: '2026-05-01',
        dateTo: '2026-05-31',
        noteFilter: 'WITH_ADJUSTMENTS',
      },
      OWNER,
    );
    for (const c of allCalls()) {
      const matches = c.sql.match(/company_id\s*=\s*\$\d+/g) ?? [];
      for (const m of matches) {
        expect(m).toMatch(/company_id\s*=\s*\$1/);
      }
    }
  });

  it('ticketTypes CSV se aplica como IN con placeholders', async () => {
    await action.execute(
      42,
      {
        dateFrom: '2026-05-01',
        dateTo: '2026-05-31',
        ticketTypes: ['SALE', 'ORDER'],
      },
      OWNER,
    );
    const invoiceCall = allCalls()[0];
    expect(invoiceCall.sql).toMatch(/si\.ticket_type::text IN \(\$\d+,\$\d+\)/);
    expect(invoiceCall.params).toContain('SALE');
    expect(invoiceCall.params).toContain('ORDER');
  });

  it('categoryIds: EXISTS sobre sale_invoice_lines→products filtrando company_id $1 y category_id IN', async () => {
    await action.execute(
      42,
      {
        dateFrom: '2026-05-01',
        dateTo: '2026-05-31',
        categoryIds: [3, 7],
      },
      OWNER,
    );
    const invoiceCall = allCalls()[0];
    // Semi-join: EXISTS contra las líneas + producto, sin duplicar filas.
    expect(invoiceCall.sql).toMatch(/EXISTS\s*\(/);
    expect(invoiceCall.sql).toMatch(/FROM sale_invoice_lines sil/);
    expect(invoiceCall.sql).toMatch(
      /JOIN products p ON p\.id = sil\.product_id AND p\.company_id = \$1/,
    );
    expect(invoiceCall.sql).toMatch(/sil\.company_id\s*=\s*\$1/);
    expect(invoiceCall.sql).toMatch(/p\.category_id IN \(\$\d+,\$\d+\)/);
    // Los ids de categoría se enlazan como parámetros (no interpolados).
    expect(invoiceCall.params).toContain(3);
    expect(invoiceCall.params).toContain(7);
  });

  it('categoryIds vacío/ausente: NO añade el EXISTS de categoría', async () => {
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' }, OWNER);
    const invoiceCall = allCalls()[0];
    expect(invoiceCall.sql).not.toMatch(/p\.category_id IN/);
  });

  it('owner/manager: NO añade filtro por created_by_id (ven todas las ventas)', async () => {
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' }, OWNER);
    for (const c of allCalls()) {
      expect(c.sql).not.toMatch(/created_by_id/);
    }
  });

  it('empleado SIN canViewAllSales (Vendedor/legacy): filtra invoices y notas por created_by_id', async () => {
    employeeEffective = ['canAccessPOS', 'canAccessSalesReport']; // Vendedor: sin canViewAllSales.
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' }, EMPLOYEE);
    const [invoiceCall, notesCall] = allCalls();
    // Ambas queries restringen al creador; el id va como string (columna texto).
    expect(invoiceCall.sql).toMatch(/si\.created_by_id\s*=\s*\$\d+/);
    expect(invoiceCall.params).toContain(String(EMPLOYEE.user_id));
    expect(notesCall.sql).toMatch(/cn\.created_by_id\s*=\s*\$\d+/);
    expect(notesCall.params).toContain(String(EMPLOYEE.user_id));
  });

  it('empleado CON canViewAllSales (Cajero): NO filtra por created_by_id (ve todas las ventas)', async () => {
    employeeEffective = ['canAccessSalesReport', 'canViewAllSales']; // Cajero: ve todo.
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' }, EMPLOYEE);
    for (const c of allCalls()) {
      expect(c.sql).not.toMatch(/created_by_id/);
    }
  });

  // ─── Flag include_orders_in_reports: ingresos con/ sin pedidos ORDER ─────────

  interface RawInvoice {
    id: string;
    ticket_type: string;
    original_total: number;
    original_cost: number;
    is_deleted: boolean;
  }

  function makeInvoice(o: RawInvoice): Record<string, unknown> {
    return {
      ...o,
      ticket_number: `T-${o.id}`,
      sale_number: o.ticket_type === 'SALE' ? `V-${o.id}` : null,
      original_profit: 0,
      original_margin: 0,
      customer_name: null,
      created_by: null,
      created_at: new Date('2026-05-10T12:00:00Z'),
      notes_count: 0,
      note_types: null,
      is_credit: false,
      credit_balance: 0,
      credit_status: null,
      paid_amount: 0,
      payment_methods: null,
    };
  }

  // Devuelve invoiceRows en la 1.ª query (invoices) y [] en la 2.ª (notas).
  function mockInvoices(rows: Record<string, unknown>[]): void {
    let call = 0;
    querySpy.mockImplementation(() => {
      call += 1;
      return Promise.resolve(call === 1 ? rows : []);
    });
  }

  const SALE = makeInvoice({
    id: '1',
    ticket_type: 'SALE',
    original_total: 100,
    original_cost: 60,
    is_deleted: false,
  });
  const ORDER = makeInvoice({
    id: '2',
    ticket_type: 'ORDER',
    original_total: 40,
    original_cost: 20,
    is_deleted: false,
  });
  const ORDER_DELETED = makeInvoice({
    id: '3',
    ticket_type: 'ORDER',
    original_total: 999,
    original_cost: 500,
    is_deleted: true,
  });

  it('flag OFF: total_revenue solo cuenta SALE (los ORDER se excluyen) y summary.include_orders_in_reports=false', async () => {
    includeOrders = false;
    mockInvoices([SALE, ORDER, ORDER_DELETED]);
    const { summary } = await action.execute(
      42,
      { dateFrom: '2026-05-01', dateTo: '2026-05-31' },
      OWNER,
    );
    expect(summary.total_revenue).toBe(100);
    expect(summary.total_cost).toBe(60);
    expect(summary.total_profit).toBe(40);
    expect(summary.include_orders_in_reports).toBe(false);
  });

  it('flag ON: el pedido se asume COMPLETO (total Y costo), como una venta normal', async () => {
    includeOrders = true;
    mockInvoices([SALE, ORDER, ORDER_DELETED]);
    const { summary } = await action.execute(
      42,
      { dateFrom: '2026-05-01', dateTo: '2026-05-31' },
      OWNER,
    );
    // 100 (SALE) + 40 (ORDER vivo). El ORDER borrado (999) NO suma.
    expect(summary.total_revenue).toBe(140);
    // 60 (SALE) + 20 (ORDER vivo). El costo del ORDER borrado (500) NO suma.
    expect(summary.total_cost).toBe(80);
    // La ganancia sube por la ganancia REAL del pedido (40 − 20 = 20), NO por su
    // total: 40 (SALE) + 20 (ORDER) = 60. Regresión del bug que inflaba la
    // ganancia con el total del pedido.
    expect(summary.total_profit).toBe(60);
    expect(summary.include_orders_in_reports).toBe(true);
  });

  it('flag ON: el margen se calcula sobre ingresos y costo con el pedido incluido', async () => {
    includeOrders = true;
    mockInvoices([SALE, ORDER]);
    const { summary } = await action.execute(
      42,
      { dateFrom: '2026-05-01', dateTo: '2026-05-31' },
      OWNER,
    );
    // margen = profit/revenue*100 = 60/140*100 = 42.857… → 42.86 (escala 2).
    expect(summary.total_revenue).toBe(140);
    expect(summary.total_cost).toBe(80);
    expect(summary.average_margin).toBeCloseTo(42.86, 2);
  });

  it('paridad con PlacePos: incluir un pedido NO altera el margen si su margen es igual al de la venta', async () => {
    includeOrders = true;
    // ORDER con el mismo margen que SALE (40%): total 50, costo 30.
    const ORDER_SAME_MARGIN = makeInvoice({
      id: '4',
      ticket_type: 'ORDER',
      original_total: 50,
      original_cost: 30,
      is_deleted: false,
    });
    mockInvoices([SALE, ORDER_SAME_MARGIN]);
    const { summary } = await action.execute(
      42,
      { dateFrom: '2026-05-01', dateTo: '2026-05-31' },
      OWNER,
    );
    // 150 ingresos, 90 costo → 60 ganancia → 40% (igual que la venta sola).
    expect(summary.total_revenue).toBe(150);
    expect(summary.total_cost).toBe(90);
    expect(summary.total_profit).toBe(60);
    expect(summary.average_margin).toBeCloseTo(40, 3);
  });

  // ─── Ventas a crédito: cuentan como una venta más (valor íntegro) ────────────

  it('la query de invoices YA NO excluye las ventas a crédito (sin `sc.id IS NULL`)', async () => {
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' }, OWNER);
    const invoiceCall = allCalls()[0];
    expect(invoiceCall.sql).not.toMatch(/sc\.id\s+IS\s+NULL/i);
    // Pero conserva el LEFT JOIN a sale_credits para exponer is_credit/saldo.
    expect(invoiceCall.sql).toMatch(/LEFT JOIN sale_credits sc/);
  });

  it('venta a crédito: suma su valor íntegro a ingresos/costo y cuenta como venta', async () => {
    const CREDIT_SALE = makeInvoice({
      id: '5',
      ticket_type: 'SALE',
      original_total: 200,
      original_cost: 120,
      is_deleted: false,
    });
    CREDIT_SALE.original_profit = 80;
    CREDIT_SALE.is_credit = true;
    CREDIT_SALE.credit_balance = 200;
    CREDIT_SALE.credit_status = 'PENDING';
    mockInvoices([SALE, CREDIT_SALE]);
    const { summary, tickets } = await action.execute(
      42,
      { dateFrom: '2026-05-01', dateTo: '2026-05-31' },
      OWNER,
    );
    // 100 (contado) + 200 (crédito) = 300; costo 60 + 120 = 180; ganancia 120.
    expect(summary.total_revenue).toBe(300);
    expect(summary.total_cost).toBe(180);
    expect(summary.total_profit).toBe(120);
    expect(summary.total_sales_count).toBe(2);
    // El ticket a crédito se distingue como "Crédito" y pendiente por su saldo
    // autoritativo (sc.balance), aunque aún no tenga pagos.
    const creditTicket = (tickets as Array<Record<string, unknown>>).find((t) => t.id === 5);
    expect(creditTicket?.paymentType).toBe('CREDIT');
    expect(creditTicket?.isCredit).toBe(true);
    expect(creditTicket?.balanceDue).toBe(200);
    expect(creditTicket?.isPending).toBe(true);
  });

  it('venta a crédito PAGADA (saldo 0): se distingue como Crédito pero NO pendiente', async () => {
    const CREDIT_PAID = makeInvoice({
      id: '6',
      ticket_type: 'SALE',
      original_total: 150,
      original_cost: 90,
      is_deleted: false,
    });
    CREDIT_PAID.is_credit = true;
    CREDIT_PAID.credit_balance = 0;
    CREDIT_PAID.credit_status = 'PAID';
    mockInvoices([CREDIT_PAID]);
    const { tickets } = await action.execute(
      42,
      { dateFrom: '2026-05-01', dateTo: '2026-05-31' },
      OWNER,
    );
    const t = (tickets as Array<Record<string, unknown>>)[0];
    expect(t.paymentType).toBe('CREDIT');
    expect(t.isPending).toBe(false);
    expect(t.balanceDue).toBe(0);
  });
});
