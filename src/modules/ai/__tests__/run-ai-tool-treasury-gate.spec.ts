import type { DataSource } from 'typeorm';

import type { DashboardService } from '@/modules/dashboard/dashboard.service';
import type { TreasuryService } from '@/modules/treasury/treasury.service';

import type { RunAiExpenseToolAction } from '../actions/run-ai-expense-tool.action';
import type { RunAiSaleToolAction } from '../actions/run-ai-sale-tool.action';
import { RunAiToolAction } from '../actions/run-ai-tool.action';
import type { RunAiTreasuryToolAction } from '../actions/run-ai-treasury-tool.action';
import type { AiToolRequestContext } from '../internal/expense-tool-helpers';
import type { AiToolActor } from '../internal/tool-catalog';

/**
 * El despachador es la última barrera antes de mover dinero: aunque el modelo
 * "alucine" una llamada a las herramientas de tesorería que no le declaramos,
 * solo el DUEÑO llega a ejecutarlas — ni el rol Administrador ni un empleado
 * con permiso de Bancos. Y siempre sobre el negocio de la sesión.
 */
describe('RunAiToolAction · gate de las herramientas de tesorería', () => {
  const TOOLS = [
    'prepare_treasury_transfer',
    'prepare_balance_correction',
    'confirm_treasury_action',
  ] as const;
  const CONTEXT: AiToolRequestContext = {
    request_id: '00000000-0000-4000-8000-000000000003',
    current_user_message: 'sí',
    previous_user_message: 'mueve 100 mil de Nequi a Efectivo',
  };

  const build = (): {
    action: RunAiToolAction;
    treasuryTools: Record<string, jest.Mock>;
    query: jest.Mock;
  } => {
    const treasuryTools = {
      prepareTransfer: jest.fn().mockResolvedValue({
        status: 'confirmation_required',
        summary: { operation: 'transfer', amount: 100000 },
      }),
      prepareCorrection: jest.fn().mockResolvedValue({ status: 'confirmation_required' }),
      confirm: jest.fn().mockResolvedValue({ status: 'executed', result: { operation: 'adjust' } }),
    };
    const query = jest.fn();
    const action = new RunAiToolAction(
      { query } as unknown as DataSource,
      {} as unknown as DashboardService,
      {} as unknown as TreasuryService,
      {} as unknown as RunAiExpenseToolAction,
      {} as unknown as RunAiSaleToolAction,
      treasuryTools as unknown as RunAiTreasuryToolAction,
      {} as never,
    );
    return { action, treasuryTools, query };
  };

  const actor = (over: Partial<AiToolActor> = {}): AiToolActor => ({
    isAdmin: false,
    permissions: new Set<string>(['canAccessBanks', 'canAccessWallets']),
    canViewProfit: true,
    userId: 9,
    is_administrator: false,
    ...over,
  });

  it.each(TOOLS)('un empleado con permiso de Bancos NO ejecuta %s', async (name) => {
    const { action, treasuryTools, query } = build();
    const execution = await action.execute(13, actor(), name, { from: 'Nequi' }, CONTEXT);

    expect(execution.ok).toBe(false);
    expect(execution.response.error).toMatch(/no tiene permiso/);
    for (const fn of Object.values(treasuryTools)) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(query).not.toHaveBeenCalled();
  });

  it.each(TOOLS)('el rol Administrador tampoco ejecuta %s', async (name) => {
    const { action, treasuryTools } = build();
    const execution = await action.execute(
      13,
      actor({ is_administrator: true }),
      name,
      {},
      CONTEXT,
    );
    expect(execution.ok).toBe(false);
    for (const fn of Object.values(treasuryTools)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('el dueño llega a cada acción con company, actor, args y contexto', async () => {
    const { action, treasuryTools } = build();
    const owner = actor({ isAdmin: true, is_administrator: true });
    const transfer = { from: 'Nequi', to: 'Efectivo', amount: 100000 };
    const correction = { account: 'Nequi', target_balance: 10000 };

    const prepared = await action.execute(
      13,
      owner,
      'prepare_treasury_transfer',
      transfer,
      CONTEXT,
    );
    expect(prepared.ok).toBe(true);
    expect(prepared.card).toEqual({
      kind: 'treasury_preview',
      data: { operation: 'transfer', amount: 100000 },
    });
    expect(treasuryTools.prepareTransfer).toHaveBeenCalledWith(13, owner, transfer, CONTEXT);

    await action.execute(13, owner, 'prepare_balance_correction', correction, CONTEXT);
    expect(treasuryTools.prepareCorrection).toHaveBeenCalledWith(13, owner, correction, CONTEXT);

    // Los argumentos que mande el modelo a la confirmación se ignoran.
    const confirmed = await action.execute(
      13,
      owner,
      'confirm_treasury_action',
      { amount: 999999, to: 'otra' },
      CONTEXT,
    );
    expect(treasuryTools.confirm).toHaveBeenCalledWith(13, owner, CONTEXT);
    expect(confirmed.card).toEqual({ kind: 'treasury_done', data: { operation: 'adjust' } });
  });

  it('un business_id de una sucursal se rechaza: escribe solo en el negocio de la sesión', async () => {
    const { action, treasuryTools } = build();
    const owner = actor({
      isAdmin: true,
      is_administrator: true,
      businesses: [
        { id: 13, name: 'Principal', is_branch: false, is_active: true },
        { id: 14, name: 'Sucursal', is_branch: true, is_active: true },
      ],
    });
    const execution = await action.execute(
      13,
      owner,
      'prepare_treasury_transfer',
      { business_id: 14, from: 'Nequi', to: 'Efectivo', amount: 1 },
      CONTEXT,
    );
    expect(execution.ok).toBe(false);
    expect(execution.response.error).toMatch(/solo se puede hacer en el negocio actual/);
    expect(treasuryTools.prepareTransfer).not.toHaveBeenCalled();
  });

  it('un fallo inesperado se devuelve como error, sin tumbar el stream', async () => {
    const { action, treasuryTools } = build();
    treasuryTools.confirm.mockRejectedValueOnce(new Error('db down'));
    const execution = await action.execute(
      13,
      actor({ isAdmin: true }),
      'confirm_treasury_action',
      {},
      CONTEXT,
    );
    expect(execution.ok).toBe(false);
    expect(execution.response.error).toMatch(/intente de nuevo/);
  });
});
