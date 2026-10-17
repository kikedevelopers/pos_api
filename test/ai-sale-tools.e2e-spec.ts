import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { RunAiExpenseToolAction } from '@/modules/ai/actions/run-ai-expense-tool.action';
import { RunAiSaleToolAction } from '@/modules/ai/actions/run-ai-sale-tool.action';
import type { AiToolRequestContext } from '@/modules/ai/internal/expense-tool-helpers';
import type { AiToolActor } from '@/modules/ai/internal/tool-catalog';
import { AssignTurnNumberAction } from '@/modules/app-settings/actions/assign-turn-number.action';
import { CreateExpenseAction } from '@/modules/expenses/actions/create-expense.action';
import type { VoidExpenseAction } from '@/modules/expenses/actions/void-expense.action';
import { ListFinancialMovementsAction } from '@/modules/financial-movements/actions/list-financial-movements.action';
import { RecordFinancialMovementAction } from '@/modules/financial-movements/actions/record-financial-movement.action';
import { FinancialMovement } from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import type { RealtimeGateway } from '@/modules/realtime/realtime.gateway';
import { CreateSaleAction } from '@/modules/sales/actions/create-sale.action';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';

import {
  cleanupCompany,
  createDisposableBranch,
  createDisposableCompany,
  insertOwnerUser,
  insertPackaging,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL pos_db) — Place registra ventas como PEDIDO POR COBRAR.
 *
 * Lo que se fija aquí (lo que NO puede fallar):
 *   - Interpreta los productos del inventario REAL ("Maizena por libra" →
 *     FECULA DE MAIZ X LIBRA) y, si el tamaño no existe, sugiere los que hay con
 *     su cantidad equivalente. Nada dudoso se factura.
 *   - Nada se crea sin un "sí" explícito en una petición POSTERIOR que responda
 *     a ESA vista previa. Lo creado es EXACTAMENTE lo que se mostró.
 *   - Exactly-once: confirmaciones repetidas o simultáneas crean UN pedido.
 *   - Aislamiento por tenant: ni productos ni clientes de otro negocio, ni por
 *     nombre ni por id; la pendiente de un usuario no la confirma otro.
 *   - Si el precio o el producto cambian entre la vista previa y el "sí", no se
 *     crea nada.
 *   - El pedido nace igual que en el POS (ORDER, sin pagos, sin tocar stock).
 */

const COMPANY = '__E2E_AI_SALE_TOOLS__';
const OTHER_COMPANY = '__E2E_AI_SALE_TOOLS_OTHER__';
const BRANCH = '__E2E_AI_SALE_TOOLS_BRANCH__';

const canConnectPromise = tryInitDataSource();

interface SaleRow {
  id: string;
  ticket_type: string;
  ticket_number: string;
  customer_id: string | null;
  customer_name: string | null;
  total: string;
  cost: string;
  profit: string;
  created_by_id: string;
  created_by: string;
  client_operation_id: string | null;
}

interface LineRow {
  product_id: string;
  description: string;
  quantity: string;
  unit_price: string;
  unit_cost: string;
  total: string;
  packaging_value: string | null;
}

describe('Place · herramienta de pedidos (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let cid = 0;
  let otherCid = 0;
  let branchCid = 0;
  let ownerId = 0;
  let employeeId = 0;
  let tools: RunAiSaleToolAction;
  let expenseTools: RunAiExpenseToolAction;
  let emitTicketChanged: jest.Mock;
  let emitComandasChanged: jest.Mock;
  let owner: AiToolActor;
  let adminEmployee: AiToolActor;
  const ids: Record<string, number> = {};

  const db = (): DataSource => {
    if (!ds) {
      throw new Error('Sin BD');
    }
    return ds;
  };
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    db().query(sql, params);

  const ctx = (
    current: string,
    previous: string | null = null,
    request_id: string = randomUUID(),
  ): AiToolRequestContext => ({
    request_id,
    current_user_message: current,
    previous_user_message: previous,
  });

  const sales = (company = cid): Promise<SaleRow[]> =>
    q<SaleRow>(
      `SELECT id, ticket_type, ticket_number, customer_id, customer_name, total::text, cost::text,
              profit::text, created_by_id, created_by, client_operation_id::text
         FROM sale_invoices WHERE company_id = $1 ORDER BY id`,
      [String(company)],
    );

  const linesOf = (sale_id: string): Promise<LineRow[]> =>
    q<LineRow>(
      `SELECT product_id, description, quantity::text, unit_price::text, unit_cost::text,
              total::text, packaging_value::text
         FROM sale_invoice_lines WHERE sale_invoice_id = $1 ORDER BY id`,
      [sale_id],
    );

  const pendingRows = (
    user_id = ownerId,
    company = cid,
  ): Promise<Array<{ status: string; action_type: string; result_ref: string | null }>> =>
    q(
      `SELECT status, action_type, result_ref FROM ai_pending_actions
        WHERE company_id = $1 AND user_id = $2 ORDER BY id`,
      [String(company), String(user_id)],
    );

  const stockOf = async (product_id: number): Promise<string> =>
    (await q<{ s: string }>(`SELECT stock::text AS s FROM products WHERE id = $1`, [product_id]))[0]
      .s;

  const addProduct = async (
    company: number,
    key: string,
    o: {
      name: string;
      cost: number;
      prices: Array<[string, number]>;
      stock?: number;
      packaging?: [string, number];
      sku?: string;
      archived?: boolean;
      show_in_pos?: boolean;
    },
  ): Promise<number> => {
    const packaging_id = o.packaging
      ? await insertPackaging(db(), company, `${o.packaging[0]} ${key}`, o.packaging[1])
      : null;
    const id = Number(
      await insertProduct(db(), company, {
        name: o.name,
        cost: o.cost,
        stock: o.stock ?? 0,
        packagingId: packaging_id,
        skuCode: o.sku ?? null,
        showInPos: o.show_in_pos ?? true,
      }),
    );
    for (const [name, sale_price] of o.prices) {
      await q(
        `INSERT INTO product_prices (company_id, product_id, name, sale_price, profit, margin, iva_percentage)
         VALUES ($1, $2, $3, $4, 0, 0, 0)`,
        [String(company), id, name, sale_price],
      );
    }
    if (o.archived) {
      await q(`UPDATE products SET is_archived = true WHERE id = $1`, [id]);
    }
    ids[key] = id;
    return id;
  };

  const addCustomer = async (
    company: number,
    key: string,
    name: string,
    doc: string | null = null,
    archived = false,
  ): Promise<number> => {
    const [row] = await q<{ id: string }>(
      `INSERT INTO customers (company_id, name, doc_number, is_archived) VALUES ($1, $2, $3, $4) RETURNING id`,
      [String(company), name, doc, archived],
    );
    ids[key] = Number(row.id);
    return ids[key];
  };

  /** Prepara con un mensaje y confirma con "sí" en la petición siguiente. */
  const prepareAndConfirm = async (
    args: Record<string, unknown>,
    trigger: string,
    actor: AiToolActor = owner,
    company = cid,
  ): Promise<{ prepared: Record<string, unknown>; confirmed: Record<string, unknown> }> => {
    const prepared = await tools.prepareSale(company, actor, args, ctx(trigger));
    const confirmed = await tools.confirmSale(company, actor, ctx('sí', trigger));
    return { prepared, confirmed };
  };

  const MAIZENA_ARGS = {
    customer: 'maria muñoz',
    items: [
      { query: 'Maizena por libra', alternatives: ['fécula de maíz por libra'], quantity: 2 },
      { query: 'fecula de yuca x libra', quantity: 1 },
    ],
  };
  const MAIZENA_TRIGGER = 'véndele a María Muñoz 2 libras de maizena y una de fécula de yuca';

  beforeAll(async () => {
    ds = await canConnectPromise;
    if (!ds) {
      return;
    }
    cid = await createDisposableCompany(ds, COMPANY);
    otherCid = await createDisposableCompany(ds, OTHER_COMPANY);
    branchCid = await createDisposableBranch(ds, BRANCH);
    ownerId = await insertOwnerUser(ds, cid, 'ai_sales');
    employeeId = Number(
      (
        await q<{ id: string }>(
          `INSERT INTO users (name, lastname, email, password, type, company_id)
           VALUES ('Ana', 'Admin', $1, 'x', 'employee', $2) RETURNING id`,
          [`__e2e_ai_sales_admin_${Date.now()}@example.test`, String(cid)],
        )
      )[0].id,
    );

    // Folios: el registro real los siembra (POST /auth/register).
    for (const company of [cid, otherCid, branchCid]) {
      for (const [type, prefix] of [
        ['ORDER', 'PED'],
        ['SALE', 'VTA'],
      ]) {
        await q(
          `INSERT INTO ticket_settings (company_id, ticket_type, current_number, prefix)
           VALUES ($1, $2, 0, $3) ON CONFLICT (company_id, ticket_type) DO NOTHING`,
          [String(company), type, prefix],
        );
      }
    }

    // Inventario real de la familia de féculas (libra colombiana = 500 g).
    await addProduct(cid, 'maiz_libra', {
      name: 'FECULA DE MAIZ X LIBRA',
      cost: 2200,
      prices: [
        ['Base', 4500],
        ['Mayorista', 4000],
      ],
      stock: 10000,
      packaging: ['LIBRA', 500],
    });
    await addProduct(cid, 'maiz_media', {
      name: 'FECULA DE MAIZ X MEDIA LIBRA',
      cost: 1100,
      prices: [['Base', 2500]],
      stock: 10000,
      packaging: ['MEDIA LIBRA', 250],
    });
    await addProduct(cid, 'maiz_gramo', {
      name: 'FECULA DE MAIZ X GRAMO',
      cost: 4.4,
      prices: [['Base', 8]],
      stock: 10000,
      packaging: ['GRAMO', 1],
    });
    await addProduct(cid, 'yuca_libra', {
      name: 'FECULA DE YUCA X LIBRA',
      cost: 3400,
      prices: [['Base', 6500]],
      stock: 500,
      packaging: ['LIBRA YUCA', 500],
    });
    await addProduct(cid, 'aceite', {
      name: 'ACEITE GIRASOL X LITRO',
      cost: 9000,
      prices: [['Base', 12000]],
      stock: 3,
      sku: 'ACE-01',
    });
    await addProduct(cid, 'archivado', {
      name: 'AZUCAR VIEJA X LIBRA',
      cost: 1000,
      prices: [['Base', 2000]],
      archived: true,
    });
    await addProduct(cid, 'oculto', {
      name: 'BOLSA PLASTICA',
      cost: 10,
      prices: [['Base', 50]],
      show_in_pos: false,
    });
    await addProduct(cid, 'sin_precio', { name: 'PANELA X LIBRA', cost: 1500, prices: [] });

    // Otro negocio: mismo nombre, otro precio. Jamás debe aparecer.
    await addProduct(otherCid, 'ajeno', {
      name: 'FECULA DE MAIZ X LIBRA',
      cost: 1,
      prices: [['Base', 9999]],
    });

    await addCustomer(cid, 'maria', 'MARÍA MUÑOZ', '1001');
    await addCustomer(cid, 'juan_carlos', 'JUAN CARLOS PEREZ', '2002');
    await addCustomer(cid, 'juan_pablo', 'JUAN PABLO PEREZ', '3003');
    await addCustomer(cid, 'archivado_cli', 'PEDRO ARCHIVADO', '4004', true);
    await addCustomer(otherCid, 'cliente_ajeno', 'CLIENTE AJENO', '5005');

    // La sucursal ve TODO el catálogo del principal (share company-level).
    await q(
      `INSERT INTO inventory_shares (source_company_id, target_company_id, product_id) VALUES ($1, $2, NULL)`,
      [String(cid), String(branchCid)],
    );

    const financial = new FinancialMovementsService(
      new ListFinancialMovementsAction(ds.getRepository(FinancialMovement)),
      new RecordFinancialMovementAction(),
    );
    emitTicketChanged = jest.fn();
    emitComandasChanged = jest.fn();
    tools = new RunAiSaleToolAction(
      ds,
      new CreateSaleAction(
        ds,
        new IncrementTicketNumberAction(),
        financial,
        new AssignTurnNumberAction(),
      ),
      { emitTicketChanged, emitComandasChanged } as unknown as RealtimeGateway,
    );
    expenseTools = new RunAiExpenseToolAction(
      ds,
      new CreateExpenseAction(ds, financial),
      {} as unknown as VoidExpenseAction,
    );

    owner = {
      isAdmin: true,
      permissions: new Set<string>(),
      canViewProfit: true,
      userId: ownerId,
      is_administrator: true,
      full_name: 'E2E Owner',
    };
    adminEmployee = {
      isAdmin: false,
      permissions: new Set<string>(['canAccessPOS']),
      canViewProfit: false,
      userId: employeeId,
      is_administrator: true,
      full_name: 'Ana Admin',
    };
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    for (const company of [cid, otherCid, branchCid]) {
      const c = String(company);
      for (const table of [
        'ai_pending_actions',
        'expenses',
        'financial_movements',
        'cash_register_logs',
        'sale_payments',
        'sale_credits',
        'sale_status_history',
        'sale_invoice_lines',
        'sale_invoices',
        'cash_registers',
        'customers',
        'ticket_settings',
      ]) {
        await q(`DELETE FROM ${table} WHERE company_id = $1`, [c]);
      }
    }
    await q(`DELETE FROM inventory_shares WHERE source_company_id = $1`, [String(cid)]);
    await cleanupCompany(ds, branchCid);
    await cleanupCompany(ds, cid);
    await cleanupCompany(ds, otherCid);
    await ds.destroy();
  });

  beforeEach(async () => {
    if (!ds) {
      return;
    }
    for (const company of [cid, branchCid]) {
      const c = String(company);
      for (const table of [
        'ai_pending_actions',
        'sale_status_history',
        'sale_invoice_lines',
        'sale_invoices',
        'app_settings',
      ]) {
        await q(`DELETE FROM ${table} WHERE company_id = $1`, [c]);
      }
    }
    emitTicketChanged.mockClear();
    emitComandasChanged.mockClear();
  });

  const itDb = (name: string, fn: () => Promise<void>): void => {
    it(name, async () => {
      if (!(await canConnectPromise)) {
        return; // sin BD en el runner: se omite limpio.
      }
      await fn();
    });
  };

  // ────────────────────────────────────────────────────────────────────────
  // Camino feliz
  // ────────────────────────────────────────────────────────────────────────

  describe('camino feliz: interpreta, muestra la factura y crea el pedido con el "sí"', () => {
    itDb(
      '"Maizena por libra" → FECULA DE MAIZ X LIBRA; vista previa con totales exactos',
      async () => {
        const prepared = await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER));

        expect(prepared.status).toBe('confirmation_required');
        expect(prepared.summary).toEqual({
          operation: 'Crear pedido por cobrar',
          customer: 'MARÍA MUÑOZ',
          lines: [
            {
              line: 1,
              product: 'FECULA DE MAIZ X LIBRA',
              size: 'libra',
              quantity: 2,
              unit_price: 4500,
              price_label: 'Base',
              total: 9000,
              note: null,
            },
            {
              line: 2,
              product: 'FECULA DE YUCA X LIBRA',
              size: 'libra',
              quantity: 1,
              unit_price: 6500,
              price_label: 'Base',
              total: 6500,
              note: null,
            },
          ],
          items_count: 2,
          total: 15500,
          warnings: [],
          after_confirm: expect.stringContaining('Tickets del POS') as unknown,
        });
        // Preparar NO crea nada.
        expect(await sales()).toEqual([]);
        expect(await pendingRows()).toEqual([
          { status: 'PENDING', action_type: 'CREATE_SALE', result_ref: null },
        ]);
      },
    );

    itDb(
      'con el "sí" crea el pedido ORDER igual que el POS (sin pagos, sin tocar stock)',
      async () => {
        const stock_before = await stockOf(ids.maiz_libra);
        const { confirmed } = await prepareAndConfirm(MAIZENA_ARGS, MAIZENA_TRIGGER);

        expect(confirmed.status).toBe('executed');
        const [sale] = await sales();
        expect(sale).toMatchObject({
          ticket_type: 'ORDER',
          customer_id: String(ids.maria),
          customer_name: 'MARÍA MUÑOZ',
          total: '15500.00',
          cost: '7800.00',
          profit: '7700.00',
          created_by_id: String(ownerId),
          created_by: 'E2E Owner',
        });
        expect(confirmed.order).toEqual({
          ticket_number: sale.ticket_number,
          customer: 'MARÍA MUÑOZ',
          lines: 2,
          total: 15500,
        });
        expect(sale.client_operation_id).toMatch(/^[0-9a-f-]{36}$/);

        expect(await linesOf(sale.id)).toEqual([
          {
            product_id: String(ids.maiz_libra),
            description: 'FECULA DE MAIZ X LIBRA',
            quantity: '2.0000',
            unit_price: '4500.00',
            unit_cost: '2200.00',
            total: '9000.00',
            packaging_value: '500.0000',
          },
          {
            product_id: String(ids.yuca_libra),
            description: 'FECULA DE YUCA X LIBRA',
            quantity: '1.0000',
            unit_price: '6500.00',
            unit_cost: '3400.00',
            total: '6500.00',
            packaging_value: '500.0000',
          },
        ]);
        // Pedido por cobrar: ni pagos ni crédito ni inventario.
        expect(
          await q(`SELECT 1 FROM sale_payments WHERE sale_invoice_id = $1`, [sale.id]),
        ).toEqual([]);
        expect(await q(`SELECT 1 FROM sale_credits WHERE sale_invoice_id = $1`, [sale.id])).toEqual(
          [],
        );
        expect(await stockOf(ids.maiz_libra)).toBe(stock_before);

        expect(await pendingRows()).toEqual([
          { status: 'EXECUTED', action_type: 'CREATE_SALE', result_ref: sale.id },
        ]);
        // Los POS abiertos se enteran del ticket nuevo (como con POST /sales).
        expect(emitTicketChanged).toHaveBeenCalledTimes(1);
        expect(emitTicketChanged).toHaveBeenCalledWith(cid, ownerId, {
          invoiceId: Number(sale.id),
          ticketNumber: sale.ticket_number,
        });
        // …y Comandas (modo restaurante), igual que POST /sales.
        expect(emitComandasChanged).toHaveBeenCalledWith(cid);
      },
    );

    itDb('el rol Administrador también crea, firmado con SU usuario', async () => {
      const { confirmed } = await prepareAndConfirm(
        { items: [{ query: 'aceite girasol', quantity: 1 }] },
        'vende un aceite',
        adminEmployee,
      );
      expect(confirmed.status).toBe('executed');
      const [sale] = await sales();
      expect(sale.created_by_id).toBe(String(employeeId));
      expect(sale.created_by).toBe('Ana Admin');
    });

    itDb('sin cliente → pedido de mostrador', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { items: [{ query: 'ACE-01', quantity: 1 }] },
        ctx('un aceite'),
      );
      expect((prepared.summary as Record<string, unknown>).customer).toBe(
        'Mostrador (sin cliente)',
      );
      await tools.confirmSale(cid, owner, ctx('dale', 'un aceite'));
      const [sale] = await sales();
      expect(sale.customer_id).toBeNull();
      expect(sale.customer_name).toBeNull();
    });

    itDb('nivel de precio por nombre (Mayorista) queda con su posición', async () => {
      const { prepared } = await prepareAndConfirm(
        { items: [{ query: 'fecula de maiz por libra', quantity: 3, price_level: 'mayorista' }] },
        '3 libras de fécula a precio mayorista',
      );
      expect((prepared.summary as { total: number }).total).toBe(12000);
      const [sale] = await sales();
      expect((await linesOf(sale.id))[0].unit_price).toBe('4000.00');
    });

    itDb('el mismo producto dicho dos veces se une en UNA línea', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        {
          items: [
            { query: 'fecula de maiz por libra', quantity: 1 },
            { product_id: ids.maiz_libra, quantity: 2 },
          ],
        },
        ctx('una libra de fécula y otras dos'),
      );
      const summary = prepared.summary as { lines: Array<{ quantity: number }>; total: number };
      expect(summary.lines).toHaveLength(1);
      expect(summary.lines[0].quantity).toBe(3);
      expect(summary.total).toBe(13500);
    });

    itDb('avisa (sin bloquear) cuando el pedido supera las existencias', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { items: [{ query: 'aceite girasol', quantity: 5 }] },
        ctx('5 aceites'),
      );
      expect(prepared.status).toBe('confirmation_required');
      expect((prepared.summary as { warnings: string[] }).warnings[0]).toMatch(
        /hay 3 y el pedido lleva 5/,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Interpretación: pregunta en vez de adivinar
  // ────────────────────────────────────────────────────────────────────────

  describe('interpretación: pregunta en vez de adivinar (y no guarda nada)', () => {
    itDb('tamaño inexistente (kilo) → sugiere libra, media y gramos con equivalencia', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { items: [{ query: 'fécula de maíz por kilo', quantity: 1 }] },
        ctx('un kilo de fécula de maíz'),
      );
      expect(prepared.status).toBe('needs_input');
      const [line] = prepared.lines as Array<Record<string, unknown>>;
      expect(line.status).toBe('size_unavailable');
      expect(line.requested_size).toBe('kilo');
      expect(
        (line.alternatives as Array<Record<string, unknown>>).map((alt) => [
          alt.name,
          alt.equivalent_quantity,
          alt.equivalent_total,
        ]),
      ).toEqual([
        ['FECULA DE MAIZ X LIBRA', 2, 9000],
        ['FECULA DE MAIZ X MEDIA LIBRA', 4, 10000],
        ['FECULA DE MAIZ X GRAMO', 1000, 8000],
      ]);
      expect(await pendingRows()).toEqual([]);
      expect(await sales()).toEqual([]);
    });

    itDb('producto y cliente ambiguos → opciones; con los ids elegidos, prepara', async () => {
      const first = await tools.prepareSale(
        cid,
        owner,
        { customer: 'juan perez', items: [{ query: 'fecula por libra', quantity: 1 }] },
        ctx('a juan perez una libra de fécula'),
      );
      expect(first.status).toBe('needs_input');
      const customer = first.customer as { status: string; options: Array<{ name: string }> };
      expect(customer.status).toBe('ambiguous');
      expect(customer.options.map((o) => o.name)).toEqual([
        'JUAN CARLOS PEREZ',
        'JUAN PABLO PEREZ',
      ]);
      const [line] = first.lines as Array<{ status: string; options: Array<{ name: string }> }>;
      expect(line.status).toBe('ambiguous');
      expect(line.options.map((o) => o.name)).toEqual([
        'FECULA DE MAIZ X LIBRA',
        'FECULA DE YUCA X LIBRA',
      ]);
      expect(await pendingRows()).toEqual([]);

      const second = await tools.prepareSale(
        cid,
        owner,
        { customer_id: ids.juan_pablo, items: [{ product_id: ids.yuca_libra, quantity: 1 }] },
        ctx('juan pablo, la de yuca'),
      );
      expect(second.status).toBe('confirmation_required');
      expect((second.summary as { customer: string }).customer).toBe('JUAN PABLO PEREZ');
    });

    itDb('el documento del cliente lo resuelve directo', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { customer: '2002', items: [{ query: 'aceite girasol', quantity: 1 }] },
        ctx('al cliente 2002 un aceite'),
      );
      expect((prepared.summary as { customer: string }).customer).toBe('JUAN CARLOS PEREZ');
    });

    itDb(
      '"media libra" con cantidad 0.5 (fracción contada dos veces) → no se interpreta',
      async () => {
        const prepared = await tools.prepareSale(
          cid,
          owner,
          {
            items: [
              { query: 'fécula de maíz por media libra', quantity: 0.5 },
              { product_id: ids.maiz_media, quantity: 0.5 },
            ],
          },
          ctx('media libra de fécula de maíz'),
        );
        expect(prepared.status).toBe('needs_input');
        expect((prepared.lines as Array<{ status: string }>).map((line) => line.status)).toEqual([
          'fraction_counted_twice',
          'fraction_counted_twice',
        ]);
        expect(await pendingRows()).toEqual([]);

        // Bien dicho: 1 × media libra, o 0.5 × libra.
        const fixed = await tools.prepareSale(
          cid,
          owner,
          {
            items: [
              { query: 'fécula de maíz por media libra', quantity: 1 },
              { query: 'fécula de maíz por libra', quantity: 0.5 },
            ],
          },
          ctx('media libra de fécula de maíz, y media de la libra'),
        );
        expect(fixed.status).toBe('confirmation_required');
        expect((fixed.summary as { total: number }).total).toBe(4750);
      },
    );

    itDb(
      'pool lleno: cada línea busca en su propio pool y la demasiado amplia no se adivina',
      async () => {
        await q(
          `INSERT INTO products (company_id, name, cost, stock, product_type, show_in_pos, is_purchasable, is_archived)
         SELECT $1, 'GALLETA SURTIDA ' || g, 100, 0, 'SIMPLE', true, false, false
           FROM generate_series(1, 401) AS g`,
          [String(cid)],
        );
        try {
          const prepared = await tools.prepareSale(
            cid,
            owner,
            {
              items: [
                { query: 'galleta surtida', quantity: 1 },
                { query: 'aceite girasol', quantity: 1 },
              ],
            },
            ctx('una galleta y un aceite'),
          );
          const [galleta, aceite] = prepared.lines as Array<{
            status: string;
            product?: { name: string };
          }>;
          expect(galleta.status).toBe('too_broad');
          // El aceite se resuelve igual: su pool propio no quedó truncado.
          expect(aceite.status).toBe('ok');
          expect(aceite.product?.name).toBe('ACEITE GIRASOL X LITRO');
          expect(await pendingRows()).toEqual([]);
        } finally {
          await q(`DELETE FROM products WHERE company_id = $1 AND name LIKE 'GALLETA SURTIDA %'`, [
            String(cid),
          ]);
        }
      },
    );

    itDb('cantidad faltante → la pide (no asume 1)', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { items: [{ query: 'aceite girasol' }] },
        ctx('vende aceite'),
      );
      expect(prepared.status).toBe('needs_input');
      expect((prepared.lines as Array<{ status: string }>)[0].status).toBe('missing_quantity');
    });

    itDb('sin productos → missing_data', async () => {
      const prepared = await tools.prepareSale(cid, owner, { customer: 'maria' }, ctx('vende'));
      expect(prepared.status).toBe('missing_data');
    });

    itDb('producto sin precios → pide precio manual', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { items: [{ query: 'panela por libra', quantity: 1 }] },
        ctx('una panela'),
      );
      expect((prepared.lines as Array<{ status: string }>)[0].status).toBe('no_prices');
    });

    itDb('cliente inexistente → no lo inventa ni lo crea', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { customer: 'Cliente Fantasma', items: [{ query: 'aceite girasol', quantity: 1 }] },
        ctx('a cliente fantasma un aceite'),
      );
      expect(prepared.status).toBe('needs_input');
      expect((prepared.customer as { status: string }).status).toBe('not_found');
      expect(
        Number(
          (
            await q<{ n: string }>(`SELECT count(*) AS n FROM customers WHERE company_id = $1`, [
              String(cid),
            ])
          )[0].n,
        ),
      ).toBe(4);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Precio manual
  // ────────────────────────────────────────────────────────────────────────

  describe('precio manual', () => {
    itDb('se respeta y queda como manual', async () => {
      const { confirmed } = await prepareAndConfirm(
        { items: [{ query: 'fecula de maiz por libra', quantity: 1, unit_price: 4200 }] },
        'una libra de fécula a 4200',
      );
      expect(confirmed.status).toBe('executed');
      const [sale] = await sales();
      expect((await linesOf(sale.id))[0].unit_price).toBe('4200.00');
      expect(sale.total).toBe('4200.00');
    });

    itDb('bajo el costo → rechazado', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { items: [{ query: 'fecula de maiz por libra', quantity: 1, unit_price: 2000 }] },
        ctx('una libra a 2000'),
      );
      expect((prepared.lines as Array<{ status: string }>)[0].status).toBe('below_cost');
      expect(await pendingRows()).toEqual([]);
    });

    itDb('bajo el margen mínimo configurado → rechazado', async () => {
      await q(
        `INSERT INTO app_settings (company_id, key, value) VALUES ($1, 'pos_margins_enabled', 'true'), ($1, 'pos_margins', '[30]')`,
        [String(cid)],
      );
      const low = await tools.prepareSale(
        cid,
        owner,
        { items: [{ query: 'fecula de maiz por libra', quantity: 1, unit_price: 3000 }] },
        ctx('una libra a 3000'),
      );
      expect((low.lines as Array<{ status: string }>)[0].status).toBe('below_min_margin');

      const ok = await tools.prepareSale(
        cid,
        owner,
        { items: [{ query: 'fecula de maiz por libra', quantity: 1, unit_price: 3200 }] },
        ctx('una libra a 3200'),
      );
      expect(ok.status).toBe('confirmation_required');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Confirmación forzada por el servidor
  // ────────────────────────────────────────────────────────────────────────

  describe('confirmación forzada por el servidor', () => {
    itDb('confirmar en la MISMA petición que preparó → no crea nada', async () => {
      const request_id = randomUUID();
      await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER, null, request_id));
      const result = await tools.confirmSale(cid, owner, ctx(MAIZENA_TRIGGER, null, request_id));
      expect(result.status).toBe('awaiting_user_reply');
      expect(await sales()).toEqual([]);
      expect((await pendingRows())[0].status).toBe('PENDING');
    });

    for (const reply of ['no', 'sí pero que sean 3', 'sí, a nombre de Juan', '¿cuánto es?']) {
      itDb(`"${reply}" no confirma y vence la pendiente`, async () => {
        await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER));
        const result = await tools.confirmSale(cid, owner, ctx(reply, MAIZENA_TRIGGER));
        expect(result.status).toBe('confirmation_not_explicit');
        expect(await sales()).toEqual([]);
        expect((await pendingRows())[0].status).toBe('EXPIRED');
        // …y un "sí" posterior ya no la revive.
        expect((await tools.confirmSale(cid, owner, ctx('sí', reply))).status).toBe(
          'no_pending_action',
        );
      });
    }

    itDb('un "sí" que responde a OTRO mensaje → stale', async () => {
      await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER));
      const result = await tools.confirmSale(cid, owner, ctx('sí', 'otra conversación'));
      expect(result.status).toBe('stale_confirmation');
      expect(await sales()).toEqual([]);
    });

    itDb('vencida (15 min) → expired', async () => {
      await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER));
      await q(
        `UPDATE ai_pending_actions SET expires_at = now() - interval '1 minute' WHERE company_id = $1`,
        [String(cid)],
      );
      const result = await tools.confirmSale(cid, owner, ctx('sí', MAIZENA_TRIGGER));
      expect(result.status).toBe('expired');
      expect(await sales()).toEqual([]);
    });

    itDb('sin pendiente → no_pending_action', async () => {
      expect((await tools.confirmSale(cid, owner, ctx('sí', 'hola'))).status).toBe(
        'no_pending_action',
      );
    });

    itDb('sin contexto de la petición → unavailable (fail-closed)', async () => {
      expect((await tools.prepareSale(cid, owner, MAIZENA_ARGS, undefined)).status).toBe(
        'unavailable',
      );
      expect((await tools.confirmSale(cid, owner, undefined)).status).toBe('unavailable');
    });

    itDb('dos pedidos en la MISMA respuesta → el segundo no se prepara', async () => {
      const context = ctx('dos pedidos');
      expect((await tools.prepareSale(cid, owner, MAIZENA_ARGS, context)).status).toBe(
        'confirmation_required',
      );
      expect(
        (
          await tools.prepareSale(
            cid,
            owner,
            { items: [{ query: 'aceite girasol', quantity: 1 }] },
            context,
          )
        ).status,
      ).toBe('one_at_a_time');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Exactly-once
  // ────────────────────────────────────────────────────────────────────────

  describe('exactly-once', () => {
    itDb('un segundo "sí" no crea otro pedido', async () => {
      const { confirmed } = await prepareAndConfirm(MAIZENA_ARGS, MAIZENA_TRIGGER);
      expect(confirmed.status).toBe('executed');
      expect((await tools.confirmSale(cid, owner, ctx('sí', MAIZENA_TRIGGER))).status).toBe(
        'no_pending_action',
      );
      expect(await sales()).toHaveLength(1);
    });

    itDb('tres "sí" SIMULTÁNEOS → exactamente un pedido', async () => {
      await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER));
      const results = await Promise.all(
        [1, 2, 3].map(() => tools.confirmSale(cid, owner, ctx('sí', MAIZENA_TRIGGER))),
      );
      expect(results.filter((r) => r.status === 'executed')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'no_pending_action')).toHaveLength(2);
      expect(await sales()).toHaveLength(1);
      expect(emitTicketChanged).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Revalidación entre la vista previa y el "sí"
  // ────────────────────────────────────────────────────────────────────────

  describe('lo creado es EXACTAMENTE lo que se mostró', () => {
    itDb('si el precio cambió → no crea y vence la pendiente', async () => {
      await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER));
      await q(
        `UPDATE product_prices SET sale_price = 4700 WHERE product_id = $1 AND name = 'Base'`,
        [ids.maiz_libra],
      );
      try {
        const result = await tools.confirmSale(cid, owner, ctx('sí', MAIZENA_TRIGGER));
        expect(result.status).toBe('changed');
        expect(await sales()).toEqual([]);
        expect((await pendingRows())[0].status).toBe('EXPIRED');
      } finally {
        await q(
          `UPDATE product_prices SET sale_price = 4500 WHERE product_id = $1 AND name = 'Base'`,
          [ids.maiz_libra],
        );
      }
    });

    itDb('si el producto se archivó → no crea', async () => {
      await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER));
      await q(`UPDATE products SET is_archived = true WHERE id = $1`, [ids.yuca_libra]);
      try {
        const result = await tools.confirmSale(cid, owner, ctx('sí', MAIZENA_TRIGGER));
        expect(result.status).toBe('changed');
        expect(await sales()).toEqual([]);
      } finally {
        await q(`UPDATE products SET is_archived = false WHERE id = $1`, [ids.yuca_libra]);
      }
    });

    itDb('si el costo cambió (el usuario no lo vio) → crea con el costo VIGENTE', async () => {
      await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER));
      await q(`UPDATE products SET cost = 2300 WHERE id = $1`, [ids.maiz_libra]);
      try {
        const result = await tools.confirmSale(cid, owner, ctx('sí', MAIZENA_TRIGGER));
        expect(result.status).toBe('executed');
        const [sale] = await sales();
        expect((await linesOf(sale.id))[0].unit_cost).toBe('2300.00');
        expect(sale.cost).toBe('8000.00');
      } finally {
        await q(`UPDATE products SET cost = 2200 WHERE id = $1`, [ids.maiz_libra]);
      }
    });

    itDb(
      'si el cliente se archivó → falla con rollback total (ni pedido ni EXECUTED)',
      async () => {
        await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER));
        await q(`UPDATE customers SET is_archived = true WHERE id = $1`, [ids.maria]);
        try {
          const result = await tools.confirmSale(cid, owner, ctx('sí', MAIZENA_TRIGGER));
          expect(result.status).toBe('failed');
          expect(String(result.message)).toMatch(/Cliente no encontrado o archivado/);
          expect(await sales()).toEqual([]);
          expect((await pendingRows())[0].status).toBe('PENDING');
        } finally {
          await q(`UPDATE customers SET is_archived = false WHERE id = $1`, [ids.maria]);
        }
      },
    );
  });

  describe('mismas reglas del DTO que POST /sales', () => {
    itDb('un nombre de producto que excede el DTO falla claro y sin crear nada', async () => {
      const long_name = `CHOCOLATINA ${'X'.repeat(210)}`;
      const id = await addProduct(cid, 'nombre_largo', {
        name: long_name,
        cost: 100,
        prices: [['Base', 500]],
      });
      try {
        const trigger = 'una chocolatina';
        const prepared = await tools.prepareSale(
          cid,
          owner,
          { items: [{ product_id: id, quantity: 1 }] },
          ctx(trigger),
        );
        expect(prepared.status).toBe('confirmation_required');
        const result = await tools.confirmSale(cid, owner, ctx('sí', trigger));
        expect(result.status).toBe('failed');
        expect(await sales()).toEqual([]);
        expect((await pendingRows())[0].status).toBe('EXPIRED');
      } finally {
        await q(`DELETE FROM product_prices WHERE product_id = $1`, [id]);
        await q(`DELETE FROM products WHERE id = $1`, [id]);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Aislamiento por tenant
  // ────────────────────────────────────────────────────────────────────────

  describe('aislamiento por tenant', () => {
    itDb('por nombre nunca aparece el producto homónimo de otro negocio', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { items: [{ query: 'fecula de maiz por libra', quantity: 1 }] },
        ctx('una libra'),
      );
      expect(
        (prepared.summary as { lines: Array<{ unit_price: number }> }).lines[0].unit_price,
      ).toBe(4500);
    });

    itDb('por id: producto de otro negocio → no disponible', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { items: [{ product_id: ids.ajeno, quantity: 1 }] },
        ctx('el producto ajeno'),
      );
      expect(prepared.status).toBe('needs_input');
      expect((prepared.lines as Array<{ status: string }>)[0].status).toBe('not_found');
      expect(await pendingRows()).toEqual([]);
    });

    itDb('por id: cliente de otro negocio → no existe', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { customer_id: ids.cliente_ajeno, items: [{ query: 'aceite girasol', quantity: 1 }] },
        ctx('al cliente ajeno'),
      );
      expect((prepared.customer as { status: string }).status).toBe('not_found');
    });

    itDb('por nombre: cliente de otro negocio → no existe', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        { customer: 'cliente ajeno', items: [{ query: 'aceite girasol', quantity: 1 }] },
        ctx('al cliente ajeno'),
      );
      expect((prepared.customer as { status: string }).status).toBe('not_found');
    });

    itDb('archivados, ocultos del POS y clientes archivados no se venden', async () => {
      const prepared = await tools.prepareSale(
        cid,
        owner,
        {
          customer_id: ids.archivado_cli,
          items: [
            { product_id: ids.archivado, quantity: 1 },
            { product_id: ids.oculto, quantity: 1 },
            { query: 'azucar vieja por libra', quantity: 1 },
          ],
        },
        ctx('vende lo archivado'),
      );
      expect((prepared.lines as Array<{ status: string }>).map((l) => l.status)).toEqual([
        'not_found',
        'not_found',
        'not_found',
      ]);
      expect((prepared.customer as { status: string }).status).toBe('not_found');
    });

    itDb(
      'la pendiente de un usuario no la confirma otro (ni el owner la del empleado)',
      async () => {
        await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER));
        const other = await tools.confirmSale(cid, adminEmployee, ctx('sí', MAIZENA_TRIGGER));
        expect(other.status).toBe('no_pending_action');
        // …ni desde otra company con el mismo usuario.
        const cross = await tools.confirmSale(otherCid, owner, ctx('sí', MAIZENA_TRIGGER));
        expect(cross.status).toBe('no_pending_action');
        expect(await sales()).toEqual([]);
        expect(await sales(otherCid)).toEqual([]);
      },
    );

    itDb(
      'la sucursal vende el catálogo COMPARTIDO del principal, en SU propia company',
      async () => {
        const { confirmed } = await prepareAndConfirm(
          { items: [{ query: 'fecula de maiz por libra', quantity: 1 }] },
          'una libra en la sucursal',
          owner,
          branchCid,
        );
        expect(confirmed.status).toBe('executed');
        const [sale] = await sales(branchCid);
        expect(sale.ticket_type).toBe('ORDER');
        expect((await linesOf(sale.id))[0].product_id).toBe(String(ids.maiz_libra));
        expect(await sales(cid)).toEqual([]);
      },
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // Gastos y pedidos no se cruzan
  // ────────────────────────────────────────────────────────────────────────

  describe('gastos y pedidos no se cruzan', () => {
    itDb('confirm_expense_action no ejecuta una pendiente de pedido (ni la vence)', async () => {
      await tools.prepareSale(cid, owner, MAIZENA_ARGS, ctx(MAIZENA_TRIGGER));
      const result = await expenseTools.confirm(cid, owner, ctx('sí', MAIZENA_TRIGGER));
      expect(result.status).toBe('wrong_operation');
      expect((await pendingRows())[0].status).toBe('PENDING');
      expect(await sales()).toEqual([]);
      // …y con la herramienta correcta sí se crea.
      expect((await tools.confirmSale(cid, owner, ctx('sí', MAIZENA_TRIGGER))).status).toBe(
        'executed',
      );
    });

    itDb('confirm_sale no ejecuta una pendiente de gasto', async () => {
      await q(
        `INSERT INTO cash_registers (company_id, user_id, balance) VALUES ($1, $2, 100000)
         ON CONFLICT DO NOTHING`,
        [String(cid), String(ownerId)],
      );
      const trigger = 'registra 5000 de pan desde caja';
      const prepared = await expenseTools.prepareRegistration(
        cid,
        owner,
        { description: 'Pan', amount: 5000, source: 'caja' },
        ctx(trigger),
      );
      expect(prepared.status).toBe('confirmation_required');
      const result = await tools.confirmSale(cid, owner, ctx('sí', trigger));
      expect(result.status).toBe('wrong_operation');
      expect((await pendingRows())[0]).toMatchObject({
        status: 'PENDING',
        action_type: 'REGISTER_EXPENSE',
      });
      expect(await sales()).toEqual([]);
    });
  });
});
