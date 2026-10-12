import type { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { CreditNote } from '@/modules/credit-notes/entities/credit-note.entity';
import { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import { FindAllSalesAction } from '@/modules/sales/actions/find-all-sales.action';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';
import { GetSalesReportAction } from '@/modules/pos-reports/actions/get-sales-report.action';

import {
  cleanupCompany,
  createDisposableCompany,
  includeOrdersFlagStub,
  insertOwnerUser,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL) — "COMPARTIR PEDIDO": EL ASIGNADO LO VE, NO LE SUMA.
 *
 * La regla innegociable de la feature: un pedido/venta compartido con un
 * empleado aparece en SU lista de informes (visibilidad) pero NO suma a sus
 * totales (la atribución es del creador) → sin doble conteo. Esto vive en SQL
 * (columna computada `assigned_only` + el OR del scope), así que los unitarios
 * del action no lo cubren; aquí se ejercita contra datos reales.
 *
 * Escenario (company desechable, 2 usuarios: creador C y asignado A):
 *   - V1: VENTA de $10.000 (gan 4.000) creada por C, COMPARTIDA con A.
 *   - V2: VENTA de $5.000 (gan 2.000) creada por A (suya propia).
 *   - P3: PEDIDO de $3.000 creado por C, COMPARTIDO con A (sigue vivo).
 *
 * `resolvePermissions` se stubea a [] (sin `canViewAllSales`) para scopear el
 * informe al actor — exactamente el caso de un Vendedor/bodeguero. El resto es
 * BD real.
 */

let seq = 0;

async function insertSale(
  db: DataSource,
  companyId: number,
  opts: {
    ticketType: 'SALE' | 'ORDER';
    total: number;
    cost: number;
    profit: number;
    createdById: number;
    assignedToUserId: number | null;
    assignedToName: string | null;
    at: string;
  },
): Promise<number> {
  seq += 1;
  const suffix = `${Date.now()}-${seq}`;
  const soldAt = opts.ticketType === 'SALE' ? opts.at : null;
  const r = await db.query(
    `INSERT INTO sale_invoices
       (company_id, ticket_type, ticket_number, sale_number, total, cost, profit,
        created_by_id, assigned_to_user_id, assigned_to_name,
        is_deleted, sold_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, $12, $12)
     RETURNING id`,
    [
      String(companyId),
      opts.ticketType,
      `E2E-ASSIGN-T-${suffix}`,
      opts.ticketType === 'SALE' ? `E2E-ASSIGN-V-${suffix}` : null,
      opts.total,
      opts.cost,
      opts.profit,
      String(opts.createdById),
      opts.assignedToUserId !== null ? String(opts.assignedToUserId) : null,
      opts.assignedToName,
      soldAt,
      opts.at,
    ],
  );
  return parseInt(r[0].id, 10);
}

const actorOf = (userId: number, companyId: number): AuthUser =>
  ({
    type: 'employee',
    account: 'employee',
    user_id: userId,
    company_id: companyId,
    name: 'E2E',
    lastname: 'Actor',
  }) as unknown as AuthUser;

describe('Compartir pedido: el asignado lo ve, no le suma (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;
  let creatorId = 0;
  let assigneeId = 0;

  // Scope por actor sin canViewAllSales (Vendedor): resolvePermissions → [].
  const resolveStub = {
    execute: async (): Promise<string[]> => [],
  } as unknown as ResolveEffectivePermissionsAction;

  let reportOff: GetSalesReportAction;
  let reportOn: GetSalesReportAction;
  let feed: FindAllSalesAction;

  const DAY = '2026-03-15';
  const AT = '2026-03-15T15:00:00.000Z';

  const V1 = { total: 10000, cost: 6000, profit: 4000 };
  const V2 = { total: 5000, cost: 3000, profit: 2000 };
  const P3 = { total: 3000, cost: 1800, profit: 1200 };

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) return;
    companyId = await createDisposableCompany(ds, '__e2e_assign_order');
    creatorId = await insertOwnerUser(ds, companyId, 'assign_creator');
    assigneeId = await insertOwnerUser(ds, companyId, 'assign_assignee');

    reportOff = new GetSalesReportAction(ds, resolveStub, includeOrdersFlagStub(false));
    reportOn = new GetSalesReportAction(ds, resolveStub, includeOrdersFlagStub(true));
    feed = new FindAllSalesAction(
      ds.getRepository(SaleInvoice),
      ds.getRepository(CreditNote),
      resolveStub,
    );

    await insertSale(ds, companyId, {
      ticketType: 'SALE',
      ...V1,
      createdById: creatorId,
      assignedToUserId: assigneeId,
      assignedToName: 'E2E Asignado',
      at: AT,
    });
    await insertSale(ds, companyId, {
      ticketType: 'SALE',
      ...V2,
      createdById: assigneeId,
      assignedToUserId: null,
      assignedToName: null,
      at: AT,
    });
    await insertSale(ds, companyId, {
      ticketType: 'ORDER',
      ...P3,
      createdById: creatorId,
      assignedToUserId: assigneeId,
      assignedToName: 'E2E Asignado',
      at: AT,
    });
  });

  afterAll(async () => {
    if (!ds) return;
    await ds.query(`DELETE FROM sale_invoices WHERE company_id = $1`, [String(companyId)]);
    await cleanupCompany(ds, companyId);
    await ds.destroy();
  });

  const maybe = (name: string, fn: () => Promise<void>): void =>
    void it(name, async () => {
      if (!ds) {
        console.warn('pos_db no disponible — test omitido');
        return;
      }
      await fn();
    });

  // ─── Reporte de Ventas del ASIGNADO ──────────────────────────────────────

  maybe('el asignado VE la venta compartida en su lista, pero NO suma a sus totales', async () => {
    const res = await reportOff.execute(companyId, { dateFrom: DAY, dateTo: DAY } as never, actorOf(assigneeId, companyId));
    const tickets = res.tickets as Array<Record<string, unknown>>;

    // La venta compartida (V1) aparece marcada assignedOnly; la propia (V2) no.
    const v1 = tickets.find((t) => t.ticketType === 'SALE' && t.consolidatedTotal === V1.total);
    const v2 = tickets.find((t) => t.ticketType === 'SALE' && t.consolidatedTotal === V2.total);
    expect(v1).toBeDefined();
    expect(v1!.assignedOnly).toBe(true);
    expect(v2).toBeDefined();
    expect(v2!.assignedOnly).toBe(false);

    // Totales: SOLO su propia venta (V2). La compartida NO suma.
    expect(res.summary.total_revenue).toBe(V2.total);
    expect(res.summary.total_profit).toBe(V2.profit);
    expect(res.summary.total_sales_count).toBe(1);
  });

  maybe('con include_orders ON, el PEDIDO asignado tampoco suma a los totales del asignado', async () => {
    const res = await reportOn.execute(companyId, { dateFrom: DAY, dateTo: DAY } as never, actorOf(assigneeId, companyId));
    // El pedido compartido (P3) NO entra al ingreso del asignado aunque el flag
    // cuente pedidos: es assigned_only.
    expect(res.summary.total_revenue).toBe(V2.total);
    expect(res.summary.total_orders_count).toBe(0);
  });

  // ─── Reporte de Ventas del CREADOR ───────────────────────────────────────

  maybe('la venta compartida SÍ suma para el CREADOR (atribución intacta, sin doble conteo)', async () => {
    const res = await reportOff.execute(companyId, { dateFrom: DAY, dateTo: DAY } as never, actorOf(creatorId, companyId));
    const tickets = res.tickets as Array<Record<string, unknown>>;
    const v1 = tickets.find((t) => t.ticketType === 'SALE' && t.consolidatedTotal === V1.total);
    expect(v1).toBeDefined();
    expect(v1!.assignedOnly).toBe(false);
    // El creador cuenta V1 (suya); V2 es del asignado y no la ve.
    expect(res.summary.total_revenue).toBe(V1.total);
    expect(res.summary.total_profit).toBe(V1.profit);
    expect(res.summary.total_sales_count).toBe(1);
  });

  // ─── Feed (GET /sales) del ASIGNADO ──────────────────────────────────────

  maybe('el feed del asignado incluye lo compartido marcado isAssignedToMe', async () => {
    const items = await feed.execute(
      companyId,
      { date_from: DAY, date_to: DAY } as never,
      actorOf(assigneeId, companyId),
    );
    const shared = items.find((i) => i.total === V1.total && i.ticketType === 'SALE');
    const own = items.find((i) => i.total === V2.total && i.ticketType === 'SALE');
    const order = items.find((i) => i.total === P3.total && i.ticketType === 'ORDER');
    expect(shared?.isAssignedToMe).toBe(true);
    expect(shared?.assignedToName).toBe('E2E Asignado');
    expect(own?.isAssignedToMe).toBe(false);
    expect(order?.isAssignedToMe).toBe(true);
  });
});
