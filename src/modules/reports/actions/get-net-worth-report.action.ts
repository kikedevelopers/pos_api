import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { fetchCashAccounts } from '@/modules/dashboard/internal/cash-accounts';

/**
 * INFORME PATRIMONIAL (snapshot a hoy) de la company activa.
 *
 *   PATRIMONIO = ACTIVOS − PASIVOS
 *
 * ACTIVOS:
 *   - Inventario a costo (SOLO productos base, `parent_id IS NULL`): las
 *     presentaciones comparten el stock del base, incluirlas doble-contaría.
 *     `cost` ya incluye el flete prorrateado y está en la misma unidad que
 *     `stock` (unidad mínima) → `Σ(cost·stock)` es exacto. El stock nunca es
 *     negativo (CHECK en BD).
 *   - Cartera: saldo PENDIENTE de los créditos de clientes (`sale_credits.balance`
 *     de ventas SALE vivas, status ≠ PAID). Es el saldo, no el total original.
 *   - Efectivo (cajas + cajeros), Bancos y Billeteras: saldos actuales
 *     (`fetchCashAccounts`). El saldo de caja ya incluye el fondo base.
 *   - Saldo a favor con proveedores (`suppliers.credit_balance`): anticipos/crédito
 *     que la company tiene A FAVOR con proveedores.
 *   - Mercancía prestada a terceros (préstamos LOAN) valuada a costo: salió del
 *     inventario pero se espera recuperar/cobrar.
 *
 * PASIVOS:
 *   - Deuda a proveedores: saldo pendiente de compras a crédito
 *     (`purchase_credits.balance`, status ≠ PAID).
 *   - Anticipos de clientes (`customers.advance_balance`): dinero recibido por
 *     adelantado que YA entró a caja/banco (y por eso infla los activos de
 *     dinero); se resta como obligación para no sobreestimar el patrimonio.
 *   - Deuda a transportistas: saldo pendiente de fletes a crédito
 *     (`carrier_credits.balance`, status ≠ PAID).
 *
 * NO se incluye nada de FLUJO (ventas/ganancia/gastos del día) ni pedidos
 * (ORDER): no son saldos patrimoniales. Todo filtra por `company_id`.
 */

export interface NetWorthAccountItem {
  id: number;
  name: string;
  balance: number;
  accountNumber?: string | null;
}

export interface NetWorthCreditItem {
  id: number;
  customerName: string;
  ticketNumber: string;
  balance: number;
  dueDate: string | null;
  status: string;
}

export interface NetWorthPartyItem {
  id: number;
  name: string;
  amount: number;
}

export interface NetWorthLoanItem {
  id: number;
  ticketNumber: string;
  customerName: string;
  amount: number;
}

export interface NetWorthReport {
  assets: {
    inventory: { amount: number; count: number };
    credits: { amount: number; count: number; items: NetWorthCreditItem[] };
    cash: { amount: number; count: number; items: NetWorthAccountItem[] };
    banks: { amount: number; count: number; items: NetWorthAccountItem[] };
    wallets: { amount: number; count: number; items: NetWorthAccountItem[] };
    supplierCredit: { amount: number; count: number; items: NetWorthPartyItem[] };
    loanedGoods: { amount: number; count: number; items: NetWorthLoanItem[] };
    total: number;
  };
  liabilities: {
    supplierDebt: { amount: number; count: number; items: NetWorthPartyItem[] };
    customerAdvances: { amount: number; count: number; items: NetWorthPartyItem[] };
    carrierDebt: { amount: number; count: number; items: NetWorthPartyItem[] };
    total: number;
  };
  netWorth: number;
  asOf: string;
}

const round2 = (n: unknown): number => preciseNumber(n, 2);

/** Suma exacta (Big.js) de una lista de montos. */
const sum = (values: number[]): number =>
  round2(values.reduce((acc, v) => acc.plus(toBig(v)), toBig(0)).toNumber());

@Injectable()
export class GetNetWorthReportAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<NetWorthReport> {
    const cid = String(companyId);

    const [
      cashAccounts,
      inventoryRow,
      creditRows,
      supplierCreditRows,
      loanRows,
      supplierDebtRows,
      advanceRows,
      carrierDebtRows,
    ] = await Promise.all([
      fetchCashAccounts(this.dataSource, companyId),
      this.fetchInventory(cid),
      this.fetchCredits(cid),
      this.fetchSupplierCredit(cid),
      this.fetchLoanedGoods(cid),
      this.fetchSupplierDebt(cid),
      this.fetchCustomerAdvances(cid),
      this.fetchCarrierDebt(cid),
    ]);

    // --- Activos ---
    const cash = {
      amount: round2(cashAccounts.totals.cashRegisters),
      count: cashAccounts.cashRegisters.length,
      items: cashAccounts.cashRegisters.map((r) => ({
        id: r.id,
        name: r.userName || 'Caja',
        balance: round2(r.balance),
      })),
    };
    const banks = {
      amount: round2(cashAccounts.totals.banks),
      count: cashAccounts.banks.length,
      items: cashAccounts.banks.map((b) => ({
        id: b.id,
        name: b.name,
        accountNumber: b.accountNumber,
        balance: round2(b.balance),
      })),
    };
    const wallets = {
      amount: round2(cashAccounts.totals.wallets),
      count: cashAccounts.wallets.length,
      items: cashAccounts.wallets.map((w) => ({
        id: w.id,
        name: w.name,
        balance: round2(w.balance),
      })),
    };
    const credits = {
      items: creditRows,
      count: creditRows.length,
      amount: sum(creditRows.map((c) => c.balance)),
    };
    const supplierCredit = {
      items: supplierCreditRows,
      count: supplierCreditRows.length,
      amount: sum(supplierCreditRows.map((s) => s.amount)),
    };
    const loanedGoods = {
      items: loanRows,
      count: loanRows.length,
      amount: sum(loanRows.map((l) => l.amount)),
    };
    const inventory = { amount: round2(inventoryRow.amount), count: inventoryRow.count };

    const assetsTotal = sum([
      inventory.amount,
      credits.amount,
      cash.amount,
      banks.amount,
      wallets.amount,
      supplierCredit.amount,
      loanedGoods.amount,
    ]);

    // --- Pasivos ---
    const supplierDebt = {
      items: supplierDebtRows,
      count: supplierDebtRows.length,
      amount: sum(supplierDebtRows.map((s) => s.amount)),
    };
    const customerAdvances = {
      items: advanceRows,
      count: advanceRows.length,
      amount: sum(advanceRows.map((a) => a.amount)),
    };
    const carrierDebt = {
      items: carrierDebtRows,
      count: carrierDebtRows.length,
      amount: sum(carrierDebtRows.map((c) => c.amount)),
    };

    const liabilitiesTotal = sum([
      supplierDebt.amount,
      customerAdvances.amount,
      carrierDebt.amount,
    ]);

    const netWorth = round2(toBig(assetsTotal).minus(toBig(liabilitiesTotal)).toNumber());

    return {
      assets: { inventory, credits, cash, banks, wallets, supplierCredit, loanedGoods, total: assetsTotal },
      liabilities: { supplierDebt, customerAdvances, carrierDebt, total: liabilitiesTotal },
      netWorth,
      asOf: new Date().toISOString(),
    };
  }

  /**
   * Inventario a costo = EXACTAMENTE el "Costo total" del negocio
   * (`calculateAnalytics.inventory_cost` en PlacePos). Replica su fórmula:
   *   - solo productos BASE (`parent_id IS NULL`) — las presentaciones comparten
   *     el stock del base; incluirlas doble-contaría.
   *   - excluye COMBO — su stock deriva de componentes ya valorizados.
   *   - solo `stock_display > 0` — deja fuera agotados y SOBREVENTA (stock
   *     negativo): un stock negativo no es un activo, es una inconsistencia; no
   *     debe restar del patrimonio.
   *   - valor = `cost × stock_display`, con `cost` por EMPAQUE base y
   *     `stock_display = round(stock / packaging_value, 4)` (sin empaque → stock
   *     crudo). Multiplicar `cost × stock` crudo inflaría por el factor de empaque.
   */
  private async fetchInventory(cid: string): Promise<{ amount: number; count: number }> {
    const rows = (await this.dataSource.query(
      `SELECT COALESCE(
                SUM(p.cost * round(p.stock / COALESCE(NULLIF(pk.value, 0), 1), 4)),
                0
              )::float AS amount,
              COUNT(*)::int AS count
         FROM products p
         LEFT JOIN packagings pk ON pk.id = p.packaging_id
        WHERE p.company_id = $1
          AND p.is_archived = false
          AND p.parent_id IS NULL
          AND p.product_type <> 'COMBO'
          AND round(p.stock / COALESCE(NULLIF(pk.value, 0), 1), 4) > 0`,
      [cid],
    )) as Array<{ amount: number; count: number }>;
    return { amount: Number(rows[0]?.amount ?? 0), count: Number(rows[0]?.count ?? 0) };
  }

  /** Cartera: saldo pendiente de créditos de ventas vivas (status ≠ PAID). */
  private async fetchCredits(cid: string): Promise<NetWorthCreditItem[]> {
    const rows = (await this.dataSource.query(
      `SELECT sc.id::int AS id,
              COALESCE(NULLIF(btrim(si.customer_name), ''), 'CONSUMIDOR FINAL') AS "customerName",
              COALESCE(si.sale_number, si.ticket_number) AS "ticketNumber",
              sc.balance::float AS balance,
              sc.due_date AS "dueDate",
              sc.status AS status
         FROM sale_credits sc
         INNER JOIN sale_invoices si
                 ON si.id = sc.sale_invoice_id AND si.company_id = sc.company_id
        WHERE sc.company_id = $1
          AND sc.status <> 'PAID'
          AND si.ticket_type = 'SALE'
          AND si.is_deleted = false
        ORDER BY sc.balance DESC`,
      [cid],
    )) as Array<{
      id: number;
      customerName: string;
      ticketNumber: string;
      balance: number;
      dueDate: Date | string | null;
      status: string;
    }>;
    return rows.map((r) => ({
      id: Number(r.id),
      customerName: r.customerName,
      ticketNumber: r.ticketNumber,
      balance: round2(r.balance),
      dueDate: r.dueDate ? new Date(r.dueDate).toISOString() : null,
      status: r.status,
    }));
  }

  /** Saldo a favor con proveedores (activo). */
  private async fetchSupplierCredit(cid: string): Promise<NetWorthPartyItem[]> {
    const rows = (await this.dataSource.query(
      `SELECT id::int AS id, legal_name AS name, credit_balance::float AS amount
         FROM suppliers
        WHERE company_id = $1 AND is_archived = false AND credit_balance > 0
        ORDER BY credit_balance DESC`,
      [cid],
    )) as Array<{ id: number; name: string; amount: number }>;
    return rows.map((r) => ({ id: Number(r.id), name: r.name, amount: round2(r.amount) }));
  }

  /** Mercancía prestada a terceros (LOAN) valuada a costo, por ticket. */
  private async fetchLoanedGoods(cid: string): Promise<NetWorthLoanItem[]> {
    const rows = (await this.dataSource.query(
      `SELECT si.id::int AS id,
              si.ticket_number AS "ticketNumber",
              COALESCE(NULLIF(btrim(si.customer_name), ''), 'CONSUMIDOR FINAL') AS "customerName",
              COALESCE(SUM(sil.unit_cost * sil.quantity), 0)::float AS amount
         FROM sale_invoices si
         INNER JOIN sale_invoice_lines sil
                 ON sil.sale_invoice_id = si.id AND sil.company_id = si.company_id
        WHERE si.company_id = $1 AND si.ticket_type = 'LOAN' AND si.is_deleted = false
        GROUP BY si.id, si.ticket_number, si.customer_name
       HAVING COALESCE(SUM(sil.unit_cost * sil.quantity), 0) > 0
        ORDER BY amount DESC`,
      [cid],
    )) as Array<{ id: number; ticketNumber: string; customerName: string; amount: number }>;
    return rows.map((r) => ({
      id: Number(r.id),
      ticketNumber: r.ticketNumber,
      customerName: r.customerName,
      amount: round2(r.amount),
    }));
  }

  /** Deuda a proveedores (pasivo), agrupada por proveedor. */
  private async fetchSupplierDebt(cid: string): Promise<NetWorthPartyItem[]> {
    const rows = (await this.dataSource.query(
      `SELECT pc.supplier_id::int AS id,
              COALESCE(s.legal_name, 'Sin proveedor') AS name,
              SUM(pc.balance)::float AS amount
         FROM purchase_credits pc
         LEFT JOIN suppliers s
                ON s.id = pc.supplier_id AND s.company_id = pc.company_id
        WHERE pc.company_id = $1 AND pc.status <> 'PAID'
        GROUP BY pc.supplier_id, s.legal_name
       HAVING SUM(pc.balance) > 0
        ORDER BY amount DESC`,
      [cid],
    )) as Array<{ id: number; name: string; amount: number }>;
    return rows.map((r) => ({ id: Number(r.id), name: r.name, amount: round2(r.amount) }));
  }

  /** Anticipos de clientes (pasivo). */
  private async fetchCustomerAdvances(cid: string): Promise<NetWorthPartyItem[]> {
    const rows = (await this.dataSource.query(
      `SELECT id::int AS id, name, advance_balance::float AS amount
         FROM customers
        WHERE company_id = $1 AND advance_balance > 0
        ORDER BY advance_balance DESC`,
      [cid],
    )) as Array<{ id: number; name: string; amount: number }>;
    return rows.map((r) => ({ id: Number(r.id), name: r.name, amount: round2(r.amount) }));
  }

  /** Deuda a transportistas (pasivo), agrupada por transportista. */
  private async fetchCarrierDebt(cid: string): Promise<NetWorthPartyItem[]> {
    const rows = (await this.dataSource.query(
      `SELECT cc.carrier_id::int AS id,
              COALESCE(c.name, 'Sin transportista') AS name,
              SUM(cc.balance)::float AS amount
         FROM carrier_credits cc
         LEFT JOIN carriers c
                ON c.id = cc.carrier_id AND c.company_id = cc.company_id
        WHERE cc.company_id = $1 AND cc.status <> 'PAID'
        GROUP BY cc.carrier_id, c.name
       HAVING SUM(cc.balance) > 0
        ORDER BY amount DESC`,
      [cid],
    )) as Array<{ id: number; name: string; amount: number }>;
    return rows.map((r) => ({ id: Number(r.id), name: r.name, amount: round2(r.amount) }));
  }
}
