import type { DataSource } from 'typeorm';

import { GetNetWorthReportAction } from '../actions/get-net-worth-report.action';

// fetchCashAccounts se importa directo (no DI) → se mockea el módulo.
jest.mock('@/modules/dashboard/internal/cash-accounts', () => ({
  fetchCashAccounts: jest.fn(() =>
    Promise.resolve({
      cashRegisters: [{ id: 1, userName: 'Ana', balance: 100.5 }],
      banks: [{ id: 2, name: 'Bancolombia', accountNumber: '123', balance: 200.25 }],
      wallets: [{ id: 3, name: 'Nequi', balance: 50 }],
      totals: { cashRegisters: 100.5, banks: 200.25, wallets: 50, grand: 350.75 },
    }),
  ),
}));

const COMPANY_ID = 42;

/** Enruta cada query por el contenido del SQL a su resultado canónico. */
function buildDataSource(): DataSource {
  const query = jest.fn((sql: string) => {
    if (sql.includes('FROM products')) return Promise.resolve([{ amount: 1000, count: 5 }]);
    if (sql.includes('sale_invoice_lines'))
      return Promise.resolve([
        { id: 9, ticketNumber: 'PED-9', customerName: 'Tercero', amount: 10 },
      ]);
    if (sql.includes('sale_credits'))
      return Promise.resolve([
        { id: 1, customerName: 'Cliente A', ticketNumber: 'VTA-1', balance: 300.1, dueDate: null, status: 'PENDING' },
        { id: 2, customerName: 'Cliente B', ticketNumber: 'VTA-2', balance: 99.9, dueDate: null, status: 'PARTIALLY_PAID' },
      ]);
    if (sql.includes('FROM suppliers'))
      return Promise.resolve([{ id: 5, name: 'Proveedor Favor', amount: 25 }]);
    if (sql.includes('purchase_credits'))
      return Promise.resolve([{ id: 7, name: 'Proveedor Deuda', amount: 500 }]);
    if (sql.includes('FROM customers'))
      return Promise.resolve([{ id: 8, name: 'Cliente Anticipo', amount: 20 }]);
    if (sql.includes('carrier_credits'))
      return Promise.resolve([{ id: 6, name: 'Transportista', amount: 30 }]);
    return Promise.resolve([]);
  });
  return { query } as unknown as DataSource;
}

describe('GetNetWorthReportAction', () => {
  it('arma activos, pasivos y patrimonio = activos − pasivos', async () => {
    const action = new GetNetWorthReportAction(buildDataSource());
    const r = await action.execute(COMPANY_ID);

    // Activos por línea.
    expect(r.assets.inventory.amount).toBe(1000);
    expect(r.assets.inventory.count).toBe(5);
    expect(r.assets.credits.amount).toBe(400); // 300.10 + 99.90
    expect(r.assets.cash.amount).toBe(100.5);
    expect(r.assets.banks.amount).toBe(200.25);
    expect(r.assets.wallets.amount).toBe(50);
    expect(r.assets.supplierCredit.amount).toBe(25);
    expect(r.assets.loanedGoods.amount).toBe(10);
    expect(r.assets.total).toBe(1785.75);

    // Pasivos por línea.
    expect(r.liabilities.supplierDebt.amount).toBe(500);
    expect(r.liabilities.customerAdvances.amount).toBe(20);
    expect(r.liabilities.carrierDebt.amount).toBe(30);
    expect(r.liabilities.total).toBe(550);

    // Patrimonio.
    expect(r.netWorth).toBe(1235.75);
    expect(r.netWorth).toBeCloseTo(r.assets.total - r.liabilities.total, 2);
    expect(typeof r.asOf).toBe('string');
  });

  it('coherencia: el monto de cada línea = suma de su detalle', async () => {
    const action = new GetNetWorthReportAction(buildDataSource());
    const r = await action.execute(COMPANY_ID);

    const sumBal = (items: { balance: number }[]) => items.reduce((s, i) => s + i.balance, 0);
    const sumAmt = (items: { amount: number }[]) => items.reduce((s, i) => s + i.amount, 0);

    expect(r.assets.credits.amount).toBeCloseTo(sumBal(r.assets.credits.items), 2);
    expect(r.assets.cash.amount).toBeCloseTo(sumBal(r.assets.cash.items), 2);
    expect(r.assets.banks.amount).toBeCloseTo(sumBal(r.assets.banks.items), 2);
    expect(r.assets.wallets.amount).toBeCloseTo(sumBal(r.assets.wallets.items), 2);
    expect(r.assets.supplierCredit.amount).toBeCloseTo(sumAmt(r.assets.supplierCredit.items), 2);
    expect(r.assets.loanedGoods.amount).toBeCloseTo(sumAmt(r.assets.loanedGoods.items), 2);
    expect(r.liabilities.supplierDebt.amount).toBeCloseTo(sumAmt(r.liabilities.supplierDebt.items), 2);
    expect(r.liabilities.customerAdvances.amount).toBeCloseTo(sumAmt(r.liabilities.customerAdvances.items), 2);
    expect(r.liabilities.carrierDebt.amount).toBeCloseTo(sumAmt(r.liabilities.carrierDebt.items), 2);
  });

  it('counts reflejan el número de items del detalle', async () => {
    const action = new GetNetWorthReportAction(buildDataSource());
    const r = await action.execute(COMPANY_ID);
    expect(r.assets.credits.count).toBe(2);
    expect(r.assets.cash.count).toBe(1);
    expect(r.liabilities.supplierDebt.count).toBe(1);
  });
});
