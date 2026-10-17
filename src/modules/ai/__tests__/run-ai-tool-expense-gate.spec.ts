import type { DataSource } from 'typeorm';

import type { DashboardService } from '@/modules/dashboard/dashboard.service';
import type { TreasuryService } from '@/modules/treasury/treasury.service';

import type { RunAiExpenseToolAction } from '../actions/run-ai-expense-tool.action';
import type { RunAiSaleToolAction } from '../actions/run-ai-sale-tool.action';
import { RunAiToolAction } from '../actions/run-ai-tool.action';
import type { AiToolRequestContext } from '../internal/expense-tool-helpers';
import type { AiToolActor } from '../internal/tool-catalog';

/**
 * El despachador es la última barrera antes de escribir: aunque el modelo
 * "alucine" una llamada a una herramienta de gastos que no le declaramos, sin
 * rol administrador NO se ejecuta nada.
 */
describe('RunAiToolAction · gate de las herramientas de gastos', () => {
  const CONTEXT: AiToolRequestContext = {
    request_id: '00000000-0000-4000-8000-000000000001',
    current_user_message: 'sí',
    previous_user_message: 'registra 5000 de pan desde caja',
  };

  const build = (): {
    action: RunAiToolAction;
    expenseTools: Record<string, jest.Mock>;
    query: jest.Mock;
  } => {
    const expenseTools = {
      prepareRegistration: jest.fn().mockResolvedValue({ status: 'confirmation_required' }),
      prepareVoid: jest.fn().mockResolvedValue({ status: 'multiple_matches' }),
      confirm: jest.fn().mockResolvedValue({ status: 'executed' }),
    };
    const query = jest.fn();
    const action = new RunAiToolAction(
      { query } as unknown as DataSource,
      {} as unknown as DashboardService,
      {} as unknown as TreasuryService,
      expenseTools as unknown as RunAiExpenseToolAction,
      {} as unknown as RunAiSaleToolAction,
    );
    return { action, expenseTools, query };
  };

  const actor = (over: Partial<AiToolActor> = {}): AiToolActor => ({
    isAdmin: false,
    permissions: new Set<string>(['canAccessExpenses']),
    canViewProfit: false,
    userId: 9,
    is_administrator: false,
    ...over,
  });

  it.each(['register_expense', 'void_expense', 'confirm_expense_action'])(
    'un empleado sin rol Administrador no ejecuta %s',
    async (name) => {
      const { action, expenseTools, query } = build();
      const execution = await action.execute(13, actor(), name, { amount: 1 }, CONTEXT);

      expect(execution.ok).toBe(false);
      expect(execution.response.error).toMatch(/no tiene permiso/);
      for (const fn of Object.values(expenseTools)) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('el administrador llega a la acción con company, actor, args y contexto', async () => {
    const { action, expenseTools } = build();
    const admin = actor({ is_administrator: true });
    const args = { description: 'Pan', amount: 5000, source: 'caja' };

    const prepared = await action.execute(13, admin, 'register_expense', args, CONTEXT);
    expect(prepared.ok).toBe(true);
    expect(expenseTools.prepareRegistration).toHaveBeenCalledWith(13, admin, args, CONTEXT);

    await action.execute(13, admin, 'void_expense', { query: 'pan' }, CONTEXT);
    expect(expenseTools.prepareVoid).toHaveBeenCalledWith(13, admin, { query: 'pan' }, CONTEXT);

    // Los argumentos que mande el modelo a la confirmación se ignoran.
    await action.execute(13, admin, 'confirm_expense_action', { amount: 999999 }, CONTEXT);
    expect(expenseTools.confirm).toHaveBeenCalledWith(13, admin, CONTEXT);
  });

  it('el owner (isAdmin) también, aunque el flag no venga marcado', async () => {
    const { action, expenseTools } = build();
    await action.execute(13, actor({ isAdmin: true }), 'confirm_expense_action', {}, CONTEXT);
    expect(expenseTools.confirm).toHaveBeenCalledTimes(1);
  });

  it('un fallo inesperado se devuelve como error, sin tumbar el stream', async () => {
    const { action, expenseTools } = build();
    expenseTools.confirm.mockRejectedValueOnce(new Error('db down'));
    const execution = await action.execute(
      13,
      actor({ is_administrator: true }),
      'confirm_expense_action',
      {},
      CONTEXT,
    );
    expect(execution.ok).toBe(false);
    expect(execution.response.error).toMatch(/intente de nuevo/);
  });
});
