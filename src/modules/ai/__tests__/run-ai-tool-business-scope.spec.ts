import type { DataSource } from 'typeorm';

import type { TodayResult } from '@/modules/dashboard/actions/get-today.action';
import type { DashboardService } from '@/modules/dashboard/dashboard.service';
import type { TreasuryService } from '@/modules/treasury/treasury.service';

import type { RunAiExpenseToolAction } from '../actions/run-ai-expense-tool.action';
import type { RunAiSaleToolAction } from '../actions/run-ai-sale-tool.action';
import { RunAiToolAction } from '../actions/run-ai-tool.action';
import type { AiBusiness } from '../internal/business-scope';
import type { AiToolRequestContext } from '../internal/expense-tool-helpers';
import type { AiToolActor } from '../internal/tool-catalog';

/**
 * Alcance multi-sucursal en el despachador: el owner consulta cualquiera de
 * SUS negocios con `business_id`, validado contra `company_members` (ya
 * resuelto en el actor). Nadie más puede apuntar a otra company.
 */
describe('RunAiToolAction · alcance por negocio (sucursales del owner)', () => {
  const MAIN: AiBusiness = { id: 10, name: 'Surtidor La 21', is_branch: false, is_active: true };
  const NORTE: AiBusiness = { id: 11, name: 'Sucursal Norte', is_branch: true, is_active: true };
  const BODEGA: AiBusiness = { id: 12, name: 'Bodega Sur', is_branch: true, is_active: false };

  const CONTEXT: AiToolRequestContext = {
    request_id: '00000000-0000-4000-8000-000000000003',
    current_user_message: 'sí',
    previous_user_message: 'registra un gasto',
  };

  const today = (over: Partial<TodayResult> = {}): TodayResult => ({
    date: '2026-10-20',
    cashSales: 0,
    transferSales: 0,
    creditPaymentsCash: 0,
    creditPaymentsTransfer: 0,
    creditPaymentsTotal: 0,
    totalCollected: 0,
    ordersTotal: 0,
    creditSales: 0,
    totalSales: 0,
    salesProfit: 0,
    salesSurplus: 0,
    salesRealProfit: 0,
    profit: 0,
    surplus: 0,
    expenses: 0,
    realProfit: 0,
    salesCount: 0,
    newCredits: { count: 0, total: 0, profit: 0 },
    purchases: {
      count: 0,
      total: 0,
      paymentsCash: 0,
      paymentsTransfer: 0,
      paymentsTotal: 0,
      supplierDebt: 0,
      todayCreditsBalance: 0,
    },
    cashAccounts: {
      cashRegisters: [],
      banks: [],
      wallets: [],
      totals: { cashRegisters: 0, banks: 0, wallets: 0, grand: 0 },
    },
    ...over,
  });

  const build = (
    summaries: Record<number, TodayResult> = {},
  ): {
    action: RunAiToolAction;
    todayFn: jest.Mock;
    accountsFn: jest.Mock;
    query: jest.Mock;
    expenseTools: Record<string, jest.Mock>;
  } => {
    const todayFn = jest.fn((companyId: number) =>
      Promise.resolve(summaries[companyId] ?? today()),
    );
    const accountsFn = jest.fn().mockResolvedValue({
      cashRegisters: [],
      banks: [],
      wallets: [],
      totals: { grand: 0 },
    });
    const query = jest.fn().mockResolvedValue([]);
    const expenseTools = {
      prepareRegistration: jest.fn().mockResolvedValue({ status: 'confirmation_required' }),
      prepareVoid: jest.fn(),
      confirm: jest.fn(),
    };
    const action = new RunAiToolAction(
      { query } as unknown as DataSource,
      { today: todayFn } as unknown as DashboardService,
      { accounts: accountsFn } as unknown as TreasuryService,
      expenseTools as unknown as RunAiExpenseToolAction,
      {} as unknown as RunAiSaleToolAction,
    );
    return { action, todayFn, accountsFn, query, expenseTools };
  };

  const owner = (businesses: AiBusiness[] = [MAIN, NORTE, BODEGA]): AiToolActor => ({
    isAdmin: true,
    permissions: new Set<string>(),
    canViewProfit: true,
    userId: 1,
    is_administrator: true,
    businesses,
  });

  describe('herramientas de lectura con business_id', () => {
    it('sin business_id consulta el negocio de la sesión y no agrega "business"', async () => {
      const { action, todayFn } = build();
      const execution = await action.execute(10, owner(), 'get_daily_summary', {});
      expect(execution.ok).toBe(true);
      expect(todayFn).toHaveBeenCalledWith(10, expect.any(String));
      expect(execution.response).not.toHaveProperty('business');
    });

    it('con el id de una sucursal consulta ESA company y dice de cuál es', async () => {
      const { action, todayFn } = build({ 11: today({ totalSales: 250000 }) });
      const execution = await action.execute(10, owner(), 'get_daily_summary', {
        business_id: 11,
        date: '2026-10-19',
      });
      expect(execution.ok).toBe(true);
      expect(todayFn).toHaveBeenCalledWith(11, '2026-10-19');
      expect(execution.response.business).toBe('Sucursal Norte');
      expect((execution.response.sales as { total: number }).total).toBe(250000);
    });

    it('desde una sucursal también consulta el principal', async () => {
      const { action, accountsFn } = build();
      const execution = await action.execute(11, owner(), 'get_treasury_accounts', {
        business_id: 10,
      });
      expect(execution.ok).toBe(true);
      expect(accountsFn).toHaveBeenCalledWith(10);
      expect(execution.response.business).toBe('Surtidor La 21');
    });

    it('las herramientas con SQL propio filtran por la company destino', async () => {
      const { action, query } = build();
      await action.execute(10, owner(), 'get_debtors', { business_id: 11 });
      expect(query).toHaveBeenCalled();
      for (const [, params] of query.mock.calls) {
        expect((params as unknown[])[0]).toBe('11');
      }
    });

    it('un id ajeno se rechaza SIN tocar la BD (anti-IDOR)', async () => {
      const { action, todayFn, query } = build();
      const execution = await action.execute(10, owner(), 'get_daily_summary', { business_id: 77 });
      expect(execution.ok).toBe(false);
      expect(execution.response.error).toMatch(/no está entre los negocios/);
      expect(todayFn).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it('una sucursal suspendida no se consulta', async () => {
      const { action, todayFn } = build();
      const execution = await action.execute(10, owner(), 'get_daily_summary', { business_id: 12 });
      expect(execution.ok).toBe(false);
      expect(execution.response.error).toMatch(/suspendida/);
      expect(todayFn).not.toHaveBeenCalled();
    });

    it('un empleado (sin negocios) no puede apuntar a otra company', async () => {
      const { action, todayFn } = build();
      const employee: AiToolActor = {
        isAdmin: false,
        permissions: new Set(['canAccessDashboard']),
        canViewProfit: true,
        userId: 5,
        is_administrator: false,
      };
      const execution = await action.execute(10, employee, 'get_daily_summary', {
        business_id: 11,
      });
      expect(execution.ok).toBe(false);
      expect(todayFn).not.toHaveBeenCalled();
    });
  });

  describe('herramientas que escriben', () => {
    it('nunca corren en otro negocio, aunque el modelo mande business_id', async () => {
      const { action, expenseTools } = build();
      const execution = await action.execute(
        10,
        owner(),
        'register_expense',
        { description: 'Luz', amount: 50000, source: 'caja', business_id: 11 },
        CONTEXT,
      );
      expect(execution.ok).toBe(false);
      expect(execution.response.error).toMatch(/negocio actual/);
      expect(expenseTools.prepareRegistration).not.toHaveBeenCalled();
    });

    it('con el business_id del negocio actual siguen funcionando', async () => {
      const { action, expenseTools } = build();
      const args = { description: 'Luz', amount: 50000, source: 'caja', business_id: 10 };
      const execution = await action.execute(10, owner(), 'register_expense', args, CONTEXT);
      expect(execution.ok).toBe(true);
      expect(expenseTools.prepareRegistration).toHaveBeenCalledWith(10, owner(), args, CONTEXT);
    });
  });

  describe('get_businesses_overview', () => {
    it('trae TODOS los negocios consultables en paralelo con el consolidado exacto', async () => {
      const { action, todayFn } = build({
        10: today({
          totalCollected: 100000.1,
          totalSales: 150000.1,
          salesCount: 12,
          creditSales: 30000,
          ordersTotal: 20000,
          salesProfit: 45000.05,
          expenses: 10000,
          salesRealProfit: 35000.05,
          cashAccounts: {
            cashRegisters: [],
            banks: [],
            wallets: [],
            totals: { cashRegisters: 0, banks: 0, wallets: 0, grand: 500000 },
          },
        }),
        11: today({
          totalCollected: 0.2,
          totalSales: 50000.2,
          salesCount: 3,
          salesProfit: 5000.1,
          expenses: 0,
          salesRealProfit: 5000.1,
        }),
      });

      const execution = await action.execute(11, owner(), 'get_businesses_overview', {
        date: '2026-10-19',
      });

      expect(execution.ok).toBe(true);
      // La suspendida no se consulta.
      expect(todayFn.mock.calls).toEqual([
        [10, '2026-10-19'],
        [11, '2026-10-19'],
      ]);
      const response = execution.response as {
        date: string;
        businesses: Array<Record<string, unknown>>;
        totals: Record<string, number>;
      };
      expect(response.date).toBe('2026-10-19');
      expect(response.businesses).toEqual([
        {
          name: 'Surtidor La 21',
          is_branch: false,
          collected: 100000.1,
          sales: 150000.1,
          sales_count: 12,
          credit_sales: 30000,
          orders: 20000,
          profit: 45000.05,
          margin: 30,
          expenses: 10000,
          real_profit: 35000.05,
          cash_balance: 500000,
        },
        {
          name: 'Sucursal Norte',
          is_branch: true,
          collected: 0.2,
          sales: 50000.2,
          sales_count: 3,
          credit_sales: 0,
          orders: 0,
          profit: 5000.1,
          margin: 10,
          expenses: 0,
          real_profit: 5000.1,
          cash_balance: 0,
        },
      ]);
      // Sin errores de coma flotante (0.1 + 0.2) y margen sobre los agregados.
      expect(response.totals).toEqual({
        collected: 100000.3,
        sales: 200000.3,
        sales_count: 15,
        credit_sales: 30000,
        orders: 20000,
        profit: 50000.15,
        margin: 25,
        expenses: 10000,
        real_profit: 40000.15,
        cash_balance: 500000,
      });
    });

    it('un día sin ventas da margen 0 (sin dividir por cero)', async () => {
      const { action } = build();
      const execution = await action.execute(10, owner(), 'get_businesses_overview', {});
      const totals = (execution.response as { totals: Record<string, number> }).totals;
      expect(totals.margin).toBe(0);
      expect(totals.sales).toBe(0);
    });

    it('fecha inválida → hoy', async () => {
      const { action, todayFn } = build();
      await action.execute(10, owner(), 'get_businesses_overview', { date: '2026-02-31' });
      const [, date] = todayFn.mock.calls[0] as [number, string];
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(date).not.toBe('2026-02-31');
    });

    it('owner sin sucursales → no se ejecuta (ni se le declara)', async () => {
      const { action, todayFn } = build();
      const execution = await action.execute(10, owner([MAIN]), 'get_businesses_overview', {});
      expect(execution.ok).toBe(false);
      expect(execution.response.error).toMatch(/no tiene sucursales activas/);
      expect(todayFn).not.toHaveBeenCalled();
    });

    it('no acepta business_id (ya cubre a todos)', async () => {
      const { action, todayFn } = build();
      const execution = await action.execute(10, owner(), 'get_businesses_overview', {
        business_id: 11,
      });
      expect(execution.ok).toBe(false);
      expect(todayFn).not.toHaveBeenCalled();
    });

    it('un fallo en una sucursal se devuelve como error, sin tumbar el stream', async () => {
      const { action, todayFn } = build();
      todayFn.mockRejectedValueOnce(new Error('db down'));
      const execution = await action.execute(10, owner(), 'get_businesses_overview', {});
      expect(execution.ok).toBe(false);
      expect(execution.response.error).toMatch(/intente de nuevo/);
    });
  });
});
