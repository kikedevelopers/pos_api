import type { DataSource } from 'typeorm';

import { toSaleResponseDto } from '@/modules/sales/dto/sale-response.dto';
import { SaleStatusEventType, SaleStatusHistory } from '@/modules/sales/entities/sale-status-history.entity';
import { recordSaleStatus } from '@/modules/sales/internal/record-sale-status.helper';
import { findSaleInCompany } from '@/modules/sales/internal/sale-lookups';

import { cleanupCompany, createDisposableCompany, tryInitDataSource } from './helpers/e2e-db';

/**
 * HISTORIAL DE ESTADOS — Tests e2e (pos_db real).
 *
 * --------------------------------------------------------------------------
 * Estrategia (declarada)
 * --------------------------------------------------------------------------
 *
 * Cablear el árbol Nest completo (create-sale → process-payment →
 * process-credit-payment → void-sale) exige DI + fixtures muy pesados (ticket
 * settings, cajas, bancos, config de margen/puntos). Siguiendo el patrón de
 * `sales-inventory-flow.e2e-spec.ts`, ejercitamos aquí el MECANISMO REAL del
 * feature contra la BD:
 *
 *   - `recordSaleStatus` (el helper REAL que insertan las 5 acciones) escribe
 *     cada evento en la MISMA secuencia que emiten los flujos productivos:
 *     CREATED → COLLECTED → CREDIT_OPENED → INSTALLMENT → PAID → VOIDED.
 *   - La lectura + serialización se hace con el camino REAL de `GET /sales/:id`
 *     (`findSaleInCompany` + query del historial ordenado + `toSaleResponseDto`),
 *     verificando que `statusHistory` sale con el shape y orden esperados.
 *
 * Además se cubre: aislamiento multi-tenant, cascade FK al borrar la venta, y
 * la lógica de BACKFILL (COLLECTED vs INSTALLMENT según exista crédito).
 *
 * NUNCA toca companies reales. Skip limpio si no hay BD.
 */

const COMPANY_A = '__E2E_STATUSHIST_A__';
const COMPANY_B = '__E2E_STATUSHIST_B__';

async function insertSaleInvoice(
  ds: DataSource,
  companyId: number,
  opts: { ticketType: 'ORDER' | 'SALE'; ticketNumber: string; total: number; createdBy?: string },
): Promise<string> {
  const r = await ds.query(
    `INSERT INTO sale_invoices
       (company_id, ticket_type, ticket_number, sale_number, subtotal, tax_total, total, cost, created_by, is_deleted)
     VALUES ($1, $2, $3, $4, $5, 0, $5, 0, $6, false)
     RETURNING id`,
    [
      String(companyId),
      opts.ticketType,
      opts.ticketNumber,
      opts.ticketType === 'SALE' ? opts.ticketNumber : null,
      opts.total,
      opts.createdBy ?? 'E2E_ACTOR',
    ],
  );
  return r[0].id;
}

/** Lee + serializa por el camino REAL de GET /sales/:id (sin HTTP). */
async function loadStatusHistoryViaSerializer(
  ds: DataSource,
  companyId: number,
  saleId: number,
): Promise<Array<{ eventType: string; amount: number | null; createdBy: string | null; createdAt: string }>> {
  const manager = ds.manager;
  const sale = await findSaleInCompany(manager, saleId, companyId, { requireActive: false });
  const statusHistory = await manager.find(SaleStatusHistory, {
    where: { sale_invoice_id: sale.id, company_id: String(companyId) },
    order: { created_at: 'ASC', id: 'ASC' },
  });
  const dto = toSaleResponseDto(sale, [], [], null, [], false, null, statusHistory);
  return dto.statusHistory;
}

describe('Historial de estados de venta (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  let companyA = 0;
  let companyB = 0;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — sale-status-history e2e SKIPPED.');
      return;
    }
    companyA = await createDisposableCompany(ds, COMPANY_A);
    companyB = await createDisposableCompany(ds, COMPANY_B);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    await ds.query(`DELETE FROM sale_status_history WHERE company_id = ANY($1)`, [
      [String(companyA), String(companyB)],
    ]);
    await ds.query(`DELETE FROM sale_payments WHERE company_id = ANY($1)`, [
      [String(companyA), String(companyB)],
    ]);
    await ds.query(`DELETE FROM sale_credits WHERE company_id = ANY($1)`, [
      [String(companyA), String(companyB)],
    ]);
    await ds.query(`DELETE FROM sale_invoices WHERE company_id = ANY($1)`, [
      [String(companyA), String(companyB)],
    ]);
    await ds.query(`DELETE FROM customers WHERE company_id = ANY($1)`, [
      [String(companyA), String(companyB)],
    ]);
    await cleanupCompany(ds, companyA);
    await cleanupCompany(ds, companyB);
    await ds.destroy();
  });

  it('migración: la tabla y el enum existen', async () => {
    if (!ds) {
      return;
    }
    const t = await ds.query(`SELECT to_regclass('public.sale_status_history') AS t`);
    expect(t[0].t).toBe('sale_status_history');
    const e = await ds.query(
      `SELECT enumlabel FROM pg_enum WHERE enumtypid = 'sale_status_event_type'::regtype ORDER BY enumsortorder`,
    );
    expect(e.map((r: { enumlabel: string }) => r.enumlabel)).toEqual([
      'CREATED',
      'COLLECTED',
      'CREDIT_OPENED',
      'INSTALLMENT',
      'PAID',
      'VOIDED',
    ]);
  });

  it('flujo pedido → cobro → abono → pagado: GET /sales/:id devuelve el statusHistory ordenado y con montos', async () => {
    if (!ds) {
      return;
    }
    const saleId = await insertSaleInvoice(ds, companyA, {
      ticketType: 'SALE',
      ticketNumber: 'SH-FLOW-1',
      total: 1000,
      createdBy: 'Cajero',
    });

    // Secuencia REAL de eventos (misma que emiten las acciones), cada uno en su TX.
    await ds.transaction((m) =>
      recordSaleStatus(m, {
        companyId: companyA,
        saleInvoiceId: Number(saleId),
        eventType: SaleStatusEventType.CREATED,
        createdBy: 'Cajero',
      }),
    );
    await ds.transaction((m) =>
      recordSaleStatus(m, {
        companyId: companyA,
        saleInvoiceId: Number(saleId),
        eventType: SaleStatusEventType.COLLECTED,
        amount: 400,
        createdBy: 'Cajero',
      }),
    );
    await ds.transaction((m) =>
      recordSaleStatus(m, {
        companyId: companyA,
        saleInvoiceId: Number(saleId),
        eventType: SaleStatusEventType.CREDIT_OPENED,
        amount: 600,
        createdBy: 'Cajero',
      }),
    );
    await ds.transaction((m) =>
      recordSaleStatus(m, {
        companyId: companyA,
        saleInvoiceId: Number(saleId),
        eventType: SaleStatusEventType.INSTALLMENT,
        amount: 600,
        createdBy: 'Cajero',
      }),
    );
    await ds.transaction((m) =>
      recordSaleStatus(m, {
        companyId: companyA,
        saleInvoiceId: Number(saleId),
        eventType: SaleStatusEventType.PAID,
        createdBy: 'Cajero',
      }),
    );

    const history = await loadStatusHistoryViaSerializer(ds, companyA, Number(saleId));

    expect(history.map((h) => h.eventType)).toEqual([
      'CREATED',
      'COLLECTED',
      'CREDIT_OPENED',
      'INSTALLMENT',
      'PAID',
    ]);
    expect(history.map((h) => h.amount)).toEqual([null, 400, 600, 600, null]);
    expect(history.every((h) => h.createdBy === 'Cajero')).toBe(true);
    // createdAt es ISO string.
    expect(history[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('desempate por id cuando dos eventos comparten created_at (INSTALLMENT antes que PAID)', async () => {
    if (!ds) {
      return;
    }
    const saleId = await insertSaleInvoice(ds, companyA, {
      ticketType: 'SALE',
      ticketNumber: 'SH-TIE-1',
      total: 500,
    });
    // Ambos eventos en la MISMA TX → mismo created_at; el id crece por orden de insert.
    await ds.transaction(async (m) => {
      await recordSaleStatus(m, {
        companyId: companyA,
        saleInvoiceId: Number(saleId),
        eventType: SaleStatusEventType.INSTALLMENT,
        amount: 500,
        createdBy: 'Cajero',
      });
      await recordSaleStatus(m, {
        companyId: companyA,
        saleInvoiceId: Number(saleId),
        eventType: SaleStatusEventType.PAID,
        createdBy: 'Cajero',
      });
    });

    const history = await loadStatusHistoryViaSerializer(ds, companyA, Number(saleId));
    expect(history.map((h) => h.eventType)).toEqual(['INSTALLMENT', 'PAID']);
  });

  it('anular: aparece VOIDED como último evento', async () => {
    if (!ds) {
      return;
    }
    const saleId = await insertSaleInvoice(ds, companyA, {
      ticketType: 'SALE',
      ticketNumber: 'SH-VOID-1',
      total: 200,
    });
    await ds.transaction((m) =>
      recordSaleStatus(m, {
        companyId: companyA,
        saleInvoiceId: Number(saleId),
        eventType: SaleStatusEventType.CREATED,
        createdBy: 'Cajero',
      }),
    );
    await ds.transaction((m) =>
      recordSaleStatus(m, {
        companyId: companyA,
        saleInvoiceId: Number(saleId),
        eventType: SaleStatusEventType.VOIDED,
        amount: 200,
        createdBy: 'Admin',
      }),
    );

    const history = await loadStatusHistoryViaSerializer(ds, companyA, Number(saleId));
    expect(history[history.length - 1].eventType).toBe('VOIDED');
    expect(history[history.length - 1].createdBy).toBe('Admin');
    expect(history[history.length - 1].amount).toBe(200);
  });

  it('aislamiento multi-tenant: el historial de la company B no se filtra en la company A', async () => {
    if (!ds) {
      return;
    }
    const saleA = await insertSaleInvoice(ds, companyA, {
      ticketType: 'SALE',
      ticketNumber: 'SH-ISO-A',
      total: 100,
    });
    const saleB = await insertSaleInvoice(ds, companyB, {
      ticketType: 'SALE',
      ticketNumber: 'SH-ISO-B',
      total: 100,
    });
    await ds.transaction((m) =>
      recordSaleStatus(m, {
        companyId: companyB,
        saleInvoiceId: Number(saleB),
        eventType: SaleStatusEventType.CREATED,
      }),
    );

    // El historial de A para su venta está vacío; el de B tiene 1 evento.
    const historyA = await loadStatusHistoryViaSerializer(ds, companyA, Number(saleA));
    expect(historyA).toHaveLength(0);
    const historyB = await loadStatusHistoryViaSerializer(ds, companyB, Number(saleB));
    expect(historyB).toHaveLength(1);
  });

  it('cascade FK: al borrar la venta se borra su historial', async () => {
    if (!ds) {
      return;
    }
    const saleId = await insertSaleInvoice(ds, companyA, {
      ticketType: 'ORDER',
      ticketNumber: 'SH-CASCADE-1',
      total: 50,
    });
    await ds.transaction((m) =>
      recordSaleStatus(m, {
        companyId: companyA,
        saleInvoiceId: Number(saleId),
        eventType: SaleStatusEventType.CREATED,
      }),
    );
    const before = await ds.query(
      `SELECT count(*)::int AS n FROM sale_status_history WHERE sale_invoice_id = $1`,
      [saleId],
    );
    expect(before[0].n).toBe(1);

    await ds.query(`DELETE FROM sale_invoices WHERE id = $1`, [saleId]);

    const after = await ds.query(
      `SELECT count(*)::int AS n FROM sale_status_history WHERE sale_invoice_id = $1`,
      [saleId],
    );
    expect(after[0].n).toBe(0);
  });

  it('backfill: clasifica el pago como COLLECTED (sin crédito) o INSTALLMENT (con crédito)', async () => {
    if (!ds) {
      return;
    }
    // Reproduce la lógica de clasificación del backfill de la migración sobre un
    // escenario controlado, verificando la equivalencia con la regla documentada.
    const insertPayment = async (saleId: string, amount: number): Promise<void> => {
      await ds!.query(
        `INSERT INTO sale_payments
           (company_id, sale_invoice_id, payment_method, amount, change_amount, account_type, account_id, is_voided)
         VALUES ($1, $2, 'CASH', $3, 0, 'cash_register', 1, false)`,
        [String(companyA), saleId, amount],
      );
    };

    // Venta 1: pago vivo, SIN crédito → COLLECTED.
    const sale1 = await insertSaleInvoice(ds, companyA, {
      ticketType: 'SALE',
      ticketNumber: 'SH-BF-1',
      total: 100,
    });
    await insertPayment(sale1, 100);

    // Venta 2: pago vivo, CON crédito → INSTALLMENT.
    const sale2 = await insertSaleInvoice(ds, companyA, {
      ticketType: 'SALE',
      ticketNumber: 'SH-BF-2',
      total: 100,
    });
    const customerId = (
      await ds.query(`INSERT INTO customers (company_id, name) VALUES ($1, 'BF Cliente') RETURNING id`, [
        String(companyA),
      ])
    )[0].id;
    await ds.query(
      `INSERT INTO sale_credits
         (company_id, sale_invoice_id, customer_id, total_amount, paid_amount, balance, status)
       VALUES ($1, $2, $3, 40, 0, 40, 'PENDING')`,
      [String(companyA), sale2, customerId],
    );
    await insertPayment(sale2, 60);

    // Ejecuta la MISMA clasificación del backfill, acotada a estas dos ventas.
    const classify = async (saleId: string): Promise<string> => {
      const rows = await ds!.query(
        `SELECT CASE WHEN sc.id IS NULL THEN 'COLLECTED' ELSE 'INSTALLMENT' END AS ev
         FROM sale_payments sp
         LEFT JOIN sale_credits sc
           ON sc.sale_invoice_id = sp.sale_invoice_id AND sc.company_id = sp.company_id
         WHERE sp.sale_invoice_id = $1 AND sp.is_voided = false`,
        [saleId],
      );
      return rows[0].ev;
    };

    expect(await classify(sale1)).toBe('COLLECTED');
    expect(await classify(sale2)).toBe('INSTALLMENT');

    // cleanup del customer creado (FK RESTRICT desde sale_credits: borrar credit antes).
    await ds.query(`DELETE FROM sale_credits WHERE company_id = $1`, [String(companyA)]);
    await ds.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
