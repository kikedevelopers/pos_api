import type { DataSource } from 'typeorm';

import type { DashboardService } from '@/modules/dashboard/dashboard.service';
import type { TreasuryService } from '@/modules/treasury/treasury.service';

import type { RunAiExpenseToolAction } from '../actions/run-ai-expense-tool.action';
import type { RunAiSaleToolAction } from '../actions/run-ai-sale-tool.action';
import type { RunAiTreasuryToolAction } from '../actions/run-ai-treasury-tool.action';
import { RunAiToolAction } from '../actions/run-ai-tool.action';
import type { AiToolActor } from '../internal/tool-catalog';

/**
 * `search_suppliers` es la herramienta con la que Place responde "¿cuánto le
 * debo a X?", "¿qué le he comprado a Y?" o "¿qué compras tengo pendientes de
 * pagar?". Como lee la BD directamente, su SQL tiene que filtrar por company y
 * contar las compras como el módulo de Compras; y como el modelo repite lo que
 * le damos, el mapeo (deuda, pagado, pendiente, archivado) tiene que ser exacto.
 */
describe('RunAiToolAction · search_suppliers', () => {
  const ADMIN: AiToolActor = {
    isAdmin: true,
    permissions: new Set<string>(),
    canViewProfit: true,
    userId: 7,
    is_administrator: true,
  };

  let action: RunAiToolAction;
  let querySpy: jest.Mock;

  const build = (rows: unknown[] = []): void => {
    querySpy = jest.fn(() => Promise.resolve(rows));
    action = new RunAiToolAction(
      { query: querySpy } as unknown as DataSource,
      {} as unknown as DashboardService,
      {} as unknown as TreasuryService,
      {} as unknown as RunAiExpenseToolAction,
      {} as unknown as RunAiSaleToolAction,
      {} as unknown as RunAiTreasuryToolAction,
    );
  };

  const run = async (
    args: Record<string, unknown>,
    rows: unknown[] = [],
  ): Promise<Record<string, unknown>> => {
    build(rows);
    const execution = await action.execute(13, ADMIN, 'search_suppliers', args);
    return execution.response;
  };

  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    legal_name: 'DISTRIBUIDORA BELTRAN',
    broker: 'Carlos Beltrán',
    phone: '3001112233',
    address: 'Calle 1',
    doc_number: '900123',
    email: 'ventas@beltran.co',
    is_archived: false,
    accumulated_debt: '150000',
    credit_balance: '0',
    payment_accounts: [
      {
        entity_name: 'Bancolombia',
        account_type: 'Ahorros',
        account_number: '123-456',
        document_type: 'NIT',
        document_number: '900123',
        agreement_number: null,
      },
    ],
    purchases_count: '3',
    total_purchased: '500000',
    total_paid: '350000',
    total_pending: '150000',
    pending_count: '1',
    paid_count: '2',
    received_count: '3',
    purchases: [
      {
        number: 'COM-0003',
        invoice_number: 'F-99',
        invoice_date: '2026-10-01',
        created_at: '2026-10-01T15:00:00.000Z',
        received: true,
        total: '150000',
        paid: '0',
        balance: '150000',
        payment_status: 'PENDING',
        items: [{ name: 'Arroz x 25kg', quantity: '10', total: '150000' }],
      },
    ],
    ...over,
  });

  const sql = (): string => String(querySpy.mock.calls[0][0]);
  const params = (): unknown[] => querySpy.mock.calls[0][1] as unknown[];

  it('nunca consulta sin company_id y pasa el id como primer parámetro', async () => {
    await run({ query: 'beltran' }, [row()]);

    expect(sql()).toContain('s.company_id = $1');
    expect(params()[0]).toBe('13');
  });

  it('busca con el patrón %texto% en minúsculas', async () => {
    await run({ query: 'BELTRÁN' }, [row()]);
    expect(params()[1]).toBe('%beltrán%');
  });

  it('sin query manda NULL para listar los de mayor deuda', async () => {
    await run({}, [row()]);
    expect(params()[1]).toBeNull();
  });

  it('acota el límite de proveedores al rango permitido', async () => {
    await run({ query: 'x', limit: 999 }, [row()]);
    expect(params()[2]).toBe(10);
  });

  it('mapea la deuda y el desglose de compras del proveedor', async () => {
    const result = await run({ query: 'beltran' }, [row()]);
    const suppliers = result.suppliers as Array<Record<string, unknown>>;

    expect(suppliers[0].name).toBe('DISTRIBUIDORA BELTRAN');
    expect(suppliers[0].debt).toBe(150000);
    expect(suppliers[0].purchasesSummary).toMatchObject({
      count: 3,
      totalPurchased: 500000,
      totalPaid: 350000,
      totalPending: 150000,
      pendingCount: 1,
      paidCount: 2,
    });
  });

  it('traduce el estado de pago y marca lo que aún se debe', async () => {
    const result = await run({ query: 'beltran' }, [row()]);
    const suppliers = result.suppliers as Array<{
      recentPurchases: Array<{
        status: string;
        isPaid: boolean;
        balance: number;
        items: unknown[];
      }>;
    }>;
    const purchase = suppliers[0].recentPurchases[0];

    expect(purchase.status).toBe('Pendiente');
    expect(purchase.isPaid).toBe(false);
    expect(purchase.balance).toBe(150000);
    expect(purchase.items).toEqual([{ product: 'Arroz x 25kg', quantity: 10, total: 150000 }]);
  });

  it('una compra pagada se marca como tal', async () => {
    const result = await run({ query: 'beltran' }, [
      row({
        purchases: [
          {
            number: 'COM-0001',
            invoice_number: null,
            invoice_date: null,
            created_at: '2026-09-01T10:00:00.000Z',
            received: true,
            total: '100000',
            paid: '100000',
            balance: '0',
            payment_status: 'PAID',
            items: [],
          },
        ],
      }),
    ]);
    const suppliers = result.suppliers as Array<{
      recentPurchases: Array<{ status: string; isPaid: boolean }>;
    }>;

    expect(suppliers[0].recentPurchases[0].status).toBe('Pagada');
    expect(suppliers[0].recentPurchases[0].isPaid).toBe(true);
  });

  it('avisa en la nota cuando el proveedor está archivado, sin ocultar su info', async () => {
    const result = await run({ query: 'beltran' }, [row({ is_archived: true })]);
    const suppliers = result.suppliers as Array<{ isArchived: boolean; debt: number }>;

    expect(suppliers[0].isArchived).toBe(true);
    // La información se entrega igual.
    expect(suppliers[0].debt).toBe(150000);
    expect(String(result.note)).toContain('ARCHIVADO');
  });

  it('no mete el aviso de archivado cuando todos están activos', async () => {
    const result = await run({ query: 'beltran' }, [row()]);
    expect(String(result.note)).not.toContain('ARCHIVADO');
  });

  it('un proveedor sin compras no inventa nada', async () => {
    const result = await run({ query: 'nuevo' }, [
      row({
        purchases_count: '0',
        total_purchased: '0',
        total_paid: '0',
        total_pending: '0',
        pending_count: '0',
        paid_count: '0',
        received_count: '0',
        purchases: null,
        accumulated_debt: '0',
      }),
    ]);
    const suppliers = result.suppliers as Array<{
      recentPurchases: unknown[];
      purchasesSummary: { count: number };
    }>;

    expect(suppliers[0].recentPurchases).toEqual([]);
    expect(suppliers[0].purchasesSummary.count).toBe(0);
  });

  it('un negocio sin proveedores devuelve lista vacía', async () => {
    const result = await run({ query: 'nadie' }, []);
    expect(result.count).toBe(0);
    expect(result.suppliers).toEqual([]);
  });
});
