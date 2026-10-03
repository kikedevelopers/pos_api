import { ForbiddenException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { PERMISSION_KEYS } from '@/modules/roles/internal/permission-catalog';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';

import { GetBranchesDailyClosureAction } from '../actions/get-branches-daily-closure.action';
import type { GetDailyClosureAction, DailyClosureResult } from '../actions/get-daily-closure.action';

/**
 * Resumen del día de TODAS las sucursales + consolidado.
 *
 *   - Solo NIVEL ADMIN (todas las PERMISSION_KEYS) y SOLO desde el principal.
 *   - Una fila por company (principal + sucursales activas) con su cierre COMPLETO.
 *   - `totals` suma los titulares y recalcula márgenes.
 */
describe('GetBranchesDailyClosureAction', () => {
  const OWNER_ACTOR = {
    user_id: 1,
    company_id: 10,
    type: 'owner' as const,
    account: 'user' as const,
  };

  /** DailyClosureResult mínimo con solo lo que consume buildTotals. */
  function closure(p: {
    cash?: number;
    consig?: number;
    abonosCash?: number;
    abonosConsig?: number;
    newCredits?: number;
    newCreditsCount?: number;
    orders?: number;
    salesProfit?: number;
    profit?: number;
    expenses?: number;
    finalTotal?: number;
    pendingCount?: number;
    pendingBalance?: number;
  }): DailyClosureResult {
    const abonosCash = p.abonosCash ?? 0;
    const abonosConsig = p.abonosConsig ?? 0;
    return {
      date: '2026-10-03',
      cashSalesTotal: p.cash ?? 0,
      consignacionesVentas: p.consig ?? 0,
      ordersTotal: p.orders ?? 0,
      salesProfit: p.salesProfit ?? 0,
      profit: p.profit ?? 0,
      expensesTotal: p.expenses ?? 0,
      finalTotal: p.finalTotal ?? 0,
      creditsBreakdown: {
        newCreditsTotal: p.newCredits ?? 0,
        newCreditsCount: p.newCreditsCount ?? 0,
        abonosCash,
        abonosConsignacion: abonosConsig,
        abonosTotal: abonosCash + abonosConsig,
      },
      totalPendingCredits: {
        count: p.pendingCount ?? 0,
        balance: p.pendingBalance ?? 0,
      },
    } as unknown as DailyClosureResult;
  }

  interface DsOpts {
    isBranch?: boolean;
    owner?: boolean;
    companies?: Array<{ id: string; name: string; is_branch: boolean; is_active: boolean }>;
  }

  function makeDs(opts: DsOpts): DataSource {
    const query = jest.fn((sql: string) => {
      if (/FROM companies\s+WHERE id/i.test(sql)) {
        return Promise.resolve([{ is_branch: opts.isBranch ?? false }]);
      }
      if (/FROM users\s+WHERE company_id/i.test(sql)) {
        return Promise.resolve(opts.owner === false ? [] : [{ user_id: '1' }]);
      }
      if (/company_members/i.test(sql)) {
        return Promise.resolve(opts.companies ?? []);
      }
      return Promise.resolve([]);
    });
    return { query } as unknown as DataSource;
  }

  function makeDailyClosure(byCompany: Record<number, DailyClosureResult>): GetDailyClosureAction {
    return {
      execute: jest.fn((companyId: number) => Promise.resolve(byCompany[companyId])),
    } as unknown as GetDailyClosureAction;
  }

  function makeResolvePerms(keys: readonly string[]): ResolveEffectivePermissionsAction {
    return { execute: jest.fn(() => Promise.resolve([...keys])) } as unknown as ResolveEffectivePermissionsAction;
  }

  const ADMIN_PERMS = makeResolvePerms(PERMISSION_KEYS);

  it('admin en el principal: devuelve principal + sucursales activas con su cierre y consolida', async () => {
    const ds = makeDs({
      isBranch: false,
      companies: [
        { id: '10', name: 'Principal', is_branch: false, is_active: true },
        { id: '20', name: 'Centro', is_branch: true, is_active: true },
        { id: '30', name: 'Norte', is_branch: true, is_active: true },
      ],
    });
    const daily = makeDailyClosure({
      10: closure({ cash: 1000, consig: 500, newCredits: 200, salesProfit: 400, profit: 350, expenses: 100, pendingBalance: 50, pendingCount: 1 }),
      20: closure({ cash: 300, abonosCash: 100, newCredits: 100, salesProfit: 120, profit: 110, expenses: 20, pendingBalance: 30, pendingCount: 2 }),
      30: closure({ cash: 0, salesProfit: 0, profit: 0, expenses: 0 }),
    });

    const action = new GetBranchesDailyClosureAction(ds, daily, ADMIN_PERMS);
    const result = await action.execute(OWNER_ACTOR, '2026-10-03');

    expect(result.branches.map((b) => b.companyId)).toEqual([10, 20, 30]);
    expect(result.branches[0].name).toBe('Principal');
    expect(result.branches[0].isBranch).toBe(false);
    expect(result.branches[1].closure.cashSalesTotal).toBe(300);

    // Consolidado.
    expect(result.totals.cashSales).toBe(1300); // 1000+300+0
    expect(result.totals.consignacionesVentas).toBe(500);
    expect(result.totals.abonosTotal).toBe(100); // solo Centro
    expect(result.totals.newCreditsTotal).toBe(300); // 200+100
    expect(result.totals.salesProfit).toBe(520); // 400+120
    expect(result.totals.expensesTotal).toBe(120); // 100+20
    expect(result.totals.pendingCreditsBalance).toBe(80); // 50+30
    expect(result.totals.pendingCreditsCount).toBe(3); // 1+2
    // salesRevenue = cash(1300) + consig(500) + credits(300) + orders(0) = 2100.
    expect(result.totals.salesRevenue).toBe(2100);
    // salesMargin = 520/2100*100 = 24.76.
    expect(result.totals.salesMargin).toBe(24.76);
    // totalCollected = cash(1300) + consig(500) + abonos(100) = 1900.
    expect(result.totals.totalCollected).toBe(1900);
  });

  it('excluye sucursales suspendidas (is_active=false) pero conserva el principal', async () => {
    const ds = makeDs({
      isBranch: false,
      companies: [
        { id: '10', name: 'Principal', is_branch: false, is_active: true },
        { id: '20', name: 'Activa', is_branch: true, is_active: true },
        { id: '30', name: 'Suspendida', is_branch: true, is_active: false },
      ],
    });
    const daily = makeDailyClosure({
      10: closure({ cash: 100 }),
      20: closure({ cash: 50 }),
    });
    const executeSpy = daily.execute as jest.Mock;

    const action = new GetBranchesDailyClosureAction(ds, daily, ADMIN_PERMS);
    const result = await action.execute(OWNER_ACTOR, '2026-10-03');

    expect(result.branches.map((b) => b.companyId)).toEqual([10, 20]);
    expect(executeSpy).not.toHaveBeenCalledWith(30, expect.anything());
    expect(result.totals.cashSales).toBe(150);
  });

  it('rechaza (403) si la company actual es una SUCURSAL', async () => {
    const ds = makeDs({ isBranch: true });
    const action = new GetBranchesDailyClosureAction(ds, makeDailyClosure({}), ADMIN_PERMS);
    await expect(action.execute({ ...OWNER_ACTOR }, '2026-10-03')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rechaza (403) a un empleado que NO es admin (p.ej. Cajero, sin todas las keys)', async () => {
    const ds = makeDs({
      isBranch: false,
      companies: [{ id: '10', name: 'Principal', is_branch: false, is_active: true }],
    });
    // Cajero: todas menos una key de admin.
    const cajeroKeys = PERMISSION_KEYS.filter((k) => k !== 'canAccessEmployees');
    const action = new GetBranchesDailyClosureAction(
      ds,
      makeDailyClosure({ 10: closure({ cash: 1 }) }),
      makeResolvePerms(cajeroKeys),
    );
    await expect(
      action.execute({ ...OWNER_ACTOR, type: 'employee', account: 'employee' }, '2026-10-03'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('permite a un empleado con rol Administrador (todas las keys)', async () => {
    const ds = makeDs({
      isBranch: false,
      companies: [{ id: '10', name: 'Principal', is_branch: false, is_active: true }],
    });
    const action = new GetBranchesDailyClosureAction(
      ds,
      makeDailyClosure({ 10: closure({ cash: 500, salesProfit: 100 }) }),
      makeResolvePerms(PERMISSION_KEYS),
    );
    const result = await action.execute(
      { ...OWNER_ACTOR, type: 'employee', account: 'employee' },
      '2026-10-03',
    );
    expect(result.branches).toHaveLength(1);
    expect(result.totals.cashSales).toBe(500);
  });

  it('propaga la fecha a GetDailyClosureAction por cada company', async () => {
    const ds = makeDs({
      isBranch: false,
      companies: [
        { id: '10', name: 'Principal', is_branch: false, is_active: true },
        { id: '20', name: 'Centro', is_branch: true, is_active: true },
      ],
    });
    const daily = makeDailyClosure({ 10: closure({}), 20: closure({}) });
    const action = new GetBranchesDailyClosureAction(ds, daily, ADMIN_PERMS);
    await action.execute(OWNER_ACTOR, '2026-09-01');

    expect(daily.execute).toHaveBeenCalledWith(10, '2026-09-01');
    expect(daily.execute).toHaveBeenCalledWith(20, '2026-09-01');
  });
});
