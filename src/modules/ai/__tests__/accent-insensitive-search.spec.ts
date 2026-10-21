import type { DataSource } from 'typeorm';

import type { DashboardService } from '@/modules/dashboard/dashboard.service';
import type { TreasuryService } from '@/modules/treasury/treasury.service';

import type { RunAiExpenseToolAction } from '../actions/run-ai-expense-tool.action';
import type { RunAiSaleToolAction } from '../actions/run-ai-sale-tool.action';
import type { RunAiTreasuryToolAction } from '../actions/run-ai-treasury-tool.action';
import { RunAiToolAction } from '../actions/run-ai-tool.action';
import type { AiToolActor } from '../internal/tool-catalog';

/**
 * El bug: buscar "BELTRÁN" no encontraba al cliente "BELTRAN" por una sola
 * tilde. Todas las búsquedas por texto del asistente (ventas por cliente,
 * inventario, clientes) deben comparar sin importar mayúsculas NI acentos.
 *
 * Estas pruebas blindan que el SQL normalice el nombre con
 * `translate(lower(btrim(...)))` en vez del `LOWER()` pelado de antes.
 */
describe('RunAiToolAction · búsqueda insensible a acentos', () => {
  const ADMIN: AiToolActor = {
    isAdmin: true,
    permissions: new Set<string>(),
    canViewProfit: true,
    userId: 7,
    is_administrator: true,
  };

  let action: RunAiToolAction;
  let querySpy: jest.Mock;

  const build = (): void => {
    querySpy = jest.fn(() => Promise.resolve([]));
    action = new RunAiToolAction(
      { query: querySpy } as unknown as DataSource,
      {} as unknown as DashboardService,
      {} as unknown as TreasuryService,
      {} as unknown as RunAiExpenseToolAction,
      {} as unknown as RunAiSaleToolAction,
      {} as unknown as RunAiTreasuryToolAction,
    );
  };

  const sqlOf = async (tool: string, args: Record<string, unknown>): Promise<string> => {
    build();
    await action.execute(13, ADMIN, tool, args);
    return String(querySpy.mock.calls[0][0]).replace(/\s+/g, ' ');
  };

  it('list_sales filtra el cliente sin importar la tilde', async () => {
    const sql = await sqlOf('list_sales', { date: '2026-05-04', customer: 'beltrán' });

    expect(sql).toContain("translate(lower(btrim(COALESCE(c.name, si.customer_name, '')))");
    expect(sql).not.toMatch(/LOWER\(COALESCE\(c\.name, si\.customer_name, ''\)\) LIKE/);
  });

  it('search_products busca en el nombre sin importar la tilde', async () => {
    const sql = await sqlOf('search_products', { query: 'árroz' });

    expect(sql).toContain('translate(lower(btrim(p.name))');
    expect(sql).not.toMatch(/LOWER\(p\.name\) LIKE/);
  });

  it('search_customers busca en el nombre sin importar la tilde', async () => {
    const sql = await sqlOf('search_customers', { query: 'beltrán' });

    expect(sql).toContain('translate(lower(btrim(c.name))');
    expect(sql).not.toMatch(/LOWER\(c\.name\) LIKE/);
  });
});
