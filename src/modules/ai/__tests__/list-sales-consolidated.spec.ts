import type { DataSource } from 'typeorm';

import type { DashboardService } from '@/modules/dashboard/dashboard.service';
import type { TreasuryService } from '@/modules/treasury/treasury.service';

import { RunAiToolAction } from '../actions/run-ai-tool.action';
import type { AiToolActor } from '../internal/tool-catalog';

/**
 * El asistente lee la BD directamente, así que su SQL tiene que filtrar y sumar
 * IGUAL que el informe equivalente. Cuando no coincide, el dueño ve una cifra
 * distinta de la del informe del mismo día y lo lee como una alucinación —
 * aunque el dato salga de la base.
 *
 * `list_sales` devolvía el total PERSISTIDO de la factura y le avisaba al
 * modelo de que "su total pudo cambiar": el asistente quedaba obligado a
 * adivinar. Ahora devuelve el consolidado, que es el mismo número del informe.
 */
describe('RunAiToolAction · list_sales consolida como los informes', () => {
  const ADMIN: AiToolActor = {
    isAdmin: true,
    permissions: new Set<string>(),
    canViewProfit: true,
    userId: 7,
  };

  let action: RunAiToolAction;
  let querySpy: jest.Mock;

  const build = (rows: unknown[] = []): void => {
    querySpy = jest.fn(() => Promise.resolve(rows));
    action = new RunAiToolAction(
      { query: querySpy } as unknown as DataSource,
      {} as unknown as DashboardService,
      {} as unknown as TreasuryService,
    );
  };

  const run = async (rows: unknown[] = []): Promise<Record<string, unknown>> => {
    build(rows);
    const execution = await action.execute(13, ADMIN, 'list_sales', { date: '2026-05-04' });
    return execution.response;
  };

  const sql = (): string => String(querySpy.mock.calls[0][0]);

  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    number: 'PED-2607',
    sold_at: new Date('2026-05-04T20:00:00.000Z'),
    total: '53946',
    profit: '30541',
    customer: 'JUAN',
    cashier: 'DAYANA',
    credit_balance: null,
    credit_status: null,
    notes_count: '1',
    payment_methods: ['CASH'],
    items: [],
    ...over,
  });

  it('el total sale de la vista consolidada, no del persistido', async () => {
    await run();

    expect(sql()).toContain('v_sale_note_adjustments');
    expect(sql()).toContain('si.total + COALESCE(adj.total_adjustment, 0)');
  });

  it('la ganancia también se consolida, con su costo', async () => {
    // Consolidar el total y dejar el costo viejo daría una ganancia que no
    // corresponde a ninguna de las dos cifras.
    await run();

    expect(sql()).toContain('si.cost + COALESCE(adj.cost_adjustment, 0)');
  });

  it('sigue excluyendo pedidos y anuladas, como el informe', async () => {
    await run();

    expect(sql()).toContain("si.ticket_type = 'SALE'");
    expect(sql()).toContain('si.is_deleted = false');
  });

  it('nunca consulta sin company_id', async () => {
    await run();

    expect(sql()).toContain('si.company_id = $1');
    expect(sql()).toContain('adj.company_id = si.company_id');
    expect((querySpy.mock.calls[0][1] as unknown[])[0]).toBe('13');
  });

  it('devuelve la venta ajustada por su consolidado', async () => {
    const result = await run([row()]);
    const sales = result.sales as Array<{ total: number; profit: number }>;

    expect(sales[0].total).toBe(53946);
    expect(sales[0].profit).toBe(30541);
  });

  it('le dice al modelo que el total YA incluye las notas', async () => {
    // El aviso anterior ("su total pudo cambiar") dejaba al asistente
    // adivinando; el nuevo le dice que puede reportar la cifra tal cual.
    const result = await run([row()]);

    expect(String(result.note)).toContain('CONSOLIDADOS');
    expect(String(result.note)).not.toContain('pudo cambiar');
  });

  it('marca el ticket que tuvo ajustes sin dejar de sumarlo', async () => {
    const result = await run([row()]);
    const sales = result.sales as Array<{ total: number; hasAdjustmentNotes: boolean }>;

    expect(sales[0].hasAdjustmentNotes).toBe(true);
    expect(sales[0].total).toBe(53946);
  });

  it('una venta sin notas no cambia de valor', async () => {
    const result = await run([row({ total: '10000', profit: '4000', notes_count: '0' })]);
    const sales = result.sales as Array<{ total: number; hasAdjustmentNotes: boolean }>;

    expect(sales[0].total).toBe(10000);
    expect(sales[0].hasAdjustmentNotes).toBe(false);
  });

  it('un día sin ventas no inventa nada', async () => {
    const result = await run([]);

    expect(result.count).toBe(0);
    expect(result.sales).toEqual([]);
  });
});
