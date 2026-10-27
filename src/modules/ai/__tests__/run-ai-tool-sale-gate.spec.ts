import type { DataSource } from 'typeorm';

import type { DashboardService } from '@/modules/dashboard/dashboard.service';
import type { TreasuryService } from '@/modules/treasury/treasury.service';

import type { RunAiExpenseToolAction } from '../actions/run-ai-expense-tool.action';
import type { RunAiSaleToolAction } from '../actions/run-ai-sale-tool.action';
import type { RunAiTreasuryToolAction } from '../actions/run-ai-treasury-tool.action';
import { RunAiToolAction, type AiToolExecution } from '../actions/run-ai-tool.action';
import type { AiToolRequestContext } from '../internal/expense-tool-helpers';
import type { AiToolActor } from '../internal/tool-catalog';

/**
 * El despachador es la última barrera antes de crear un pedido: aunque el
 * modelo "alucine" una llamada a prepare_sale/confirm_sale que no le
 * declaramos, sin ser owner o rol Administrador NO se ejecuta nada — ni
 * siquiera con el permiso del POS.
 */
describe('RunAiToolAction · gate de las herramientas de pedidos', () => {
  const CONTEXT: AiToolRequestContext = {
    request_id: '00000000-0000-4000-8000-000000000002',
    current_user_message: 'sí',
    previous_user_message: 'véndele a Juan 2 libras de fécula',
  };

  const build = (): {
    action: RunAiToolAction;
    saleTools: Record<string, jest.Mock>;
    query: jest.Mock;
  } => {
    const saleTools = {
      prepareSale: jest.fn().mockResolvedValue({ status: 'confirmation_required' }),
      confirmSale: jest.fn().mockResolvedValue({ status: 'executed' }),
    };
    const query = jest.fn();
    const action = new RunAiToolAction(
      { query } as unknown as DataSource,
      {} as unknown as DashboardService,
      {} as unknown as TreasuryService,
      {} as unknown as RunAiExpenseToolAction,
      saleTools as unknown as RunAiSaleToolAction,
      {} as unknown as RunAiTreasuryToolAction,
      {} as never,
    );
    return { action, saleTools, query };
  };

  const actor = (over: Partial<AiToolActor> = {}): AiToolActor => ({
    isAdmin: false,
    permissions: new Set<string>(['canAccessPOS']),
    canViewProfit: false,
    userId: 9,
    is_administrator: false,
    ...over,
  });

  it.each(['prepare_sale', 'confirm_sale'])(
    'un Cajero/Vendedor (con POS pero sin rol Administrador) no ejecuta %s',
    async (name) => {
      const { action, saleTools, query } = build();
      const execution = await action.execute(13, actor(), name, { items: [] }, CONTEXT);

      expect(execution.ok).toBe(false);
      expect(execution.response.error).toMatch(/no tiene permiso/);
      for (const fn of Object.values(saleTools)) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(['prepare_sale', 'confirm_sale'])(
    'un rol Administrador SIN el permiso del POS tampoco ejecuta %s',
    async (name) => {
      const { action, saleTools } = build();
      const execution = await action.execute(
        13,
        actor({ is_administrator: true, permissions: new Set(['canAccessExpenses']) }),
        name,
        {},
        CONTEXT,
      );
      expect(execution.ok).toBe(false);
      expect(saleTools.prepareSale).not.toHaveBeenCalled();
      expect(saleTools.confirmSale).not.toHaveBeenCalled();
    },
  );

  it('el administrador llega a la acción con company, actor, args y contexto', async () => {
    const { action, saleTools } = build();
    const admin = actor({ is_administrator: true });
    const args = { customer: 'Juan', items: [{ query: 'fécula de maíz por libra', quantity: 2 }] };

    const prepared = await action.execute(13, admin, 'prepare_sale', args, CONTEXT);
    expect(prepared.ok).toBe(true);
    expect(saleTools.prepareSale).toHaveBeenCalledWith(13, admin, args, CONTEXT);

    // Los argumentos que mande el modelo a la confirmación se ignoran.
    await action.execute(
      13,
      admin,
      'confirm_sale',
      { total: 1, items: [{ product_id: 1 }] },
      CONTEXT,
    );
    expect(saleTools.confirmSale).toHaveBeenCalledWith(13, admin, CONTEXT);
  });

  it('el owner (isAdmin) también, aunque no tenga el permiso ni el flag marcados', async () => {
    const { action, saleTools } = build();
    await action.execute(
      13,
      actor({ isAdmin: true, permissions: new Set() }),
      'confirm_sale',
      {},
      CONTEXT,
    );
    expect(saleTools.confirmSale).toHaveBeenCalledTimes(1);
  });

  it('un fallo inesperado se devuelve como error, sin tumbar el stream', async () => {
    const { action, saleTools } = build();
    saleTools.prepareSale.mockRejectedValueOnce(new Error('db down'));
    const execution = await action.execute(
      13,
      actor({ is_administrator: true }),
      'prepare_sale',
      { items: [{ query: 'arroz', quantity: 1 }] },
      CONTEXT,
    );
    expect(execution.ok).toBe(false);
    expect(execution.response.error).toMatch(/intente de nuevo/);
  });

  describe('ganancia y margen en la vista previa', () => {
    const SUMMARY = {
      customer: 'MARÍA',
      lines: [{ product: 'FECULA', quantity: 2, total: 9000, profit: 4600, margin: 51.11 }],
      total: 9000,
      profit: 4600,
      margin: 51.11,
    };
    const prepare = async (over: Partial<AiToolActor>): Promise<AiToolExecution> => {
      const { action, saleTools } = build();
      saleTools.prepareSale.mockResolvedValueOnce({
        status: 'confirmation_required',
        summary: SUMMARY,
      });
      return action.execute(
        13,
        actor({ is_administrator: true, ...over }),
        'prepare_sale',
        {},
        CONTEXT,
      );
    };

    it('quien puede ver ganancias las recibe en la respuesta y en la tarjeta', async () => {
      const execution = await prepare({ canViewProfit: true });
      expect(execution.card).toEqual({ kind: 'sale_preview', data: SUMMARY });
    });

    it('sin permiso de ganancias NO salen del servidor (ni al modelo ni a la tarjeta)', async () => {
      const execution = await prepare({ canViewProfit: false });
      expect(JSON.stringify([execution.response, execution.card])).not.toMatch(/profit|margin/);
      expect(execution.card).toEqual({
        kind: 'sale_preview',
        data: {
          customer: 'MARÍA',
          lines: [{ product: 'FECULA', quantity: 2, total: 9000 }],
          total: 9000,
        },
      });
    });
  });
});
