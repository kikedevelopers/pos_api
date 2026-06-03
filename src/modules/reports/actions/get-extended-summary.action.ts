import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { fetchCashAccounts } from '@/modules/dashboard/internal/cash-accounts';
import { parseDateRange, startOfMonthUtc, todayUtc } from '@/modules/dashboard/internal/date-range';

import { toBig } from '@/common/utils/precision';

import {
  computeConsignacionesProfit,
  computeNetCashSales,
  fetchCashNotes,
  fetchCashSales,
  fetchExpensesTotal,
  fetchNewCredits,
  fetchTotalPendingCredits,
  fetchTransferSales,
} from '../internal/sales-aggregations';

// ─── Tipos internos de compras / transportistas ────────────────────────────────

interface PurchasesTotalRow {
  total: number;
}

interface PurchasesByStatusRow {
  count: string | number;
  total: number;
}

interface PurchasePaymentsRow {
  electronicos: number;
  efectivo: number;
}

interface PurchaseCreditsBalanceRow {
  balance: number;
}

interface CarrierPaymentsRow {
  abonos: number;
}

interface CarrierPendingRow {
  pendientes: number;
}

// ─── Contrato de respuesta ─────────────────────────────────────────────────────

export interface ExtendedSummaryResult {
  from: string;
  to: string;
  ventas: {
    efectivo: number;
    electronico: number;
    credito: number;
    total: number;
    ganancia: number;
    margen: number;
  };
  gastos: { total: number };
  gananciaReal: number;
  cartera: { balance: number; count: number };
  compras: {
    total: number;
    saldosPorPagar: number;
    pagosElectronicos: number;
    pagosEfectivo: number;
    recibidas: { count: number; total: number };
    noRecibidas: { count: number; total: number };
    abonosTransportistas: number;
    abonosTransportistasPendientes: number;
  };
  cajas: {
    registros: { id: number; nombre: string; balance: number }[];
    bancos: { id: number; nombre: string; balance: number }[];
    wallets: { id: number; nombre: string; balance: number }[];
    totales: { cajas: number; bancos: number; wallets: number; total: number };
  };
}

const round2 = (n: unknown): number => Number(toBig(n).round(2).toString());

/**
 * `GET /reports/extended-summary?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 *
 * Resumen financiero EXTENDIDO sobre un rango. Reutiliza al máximo lo existente:
 *
 *   - VENTAS (efectivo/electronico/credito + ganancia/margen) netas de NC/ND →
 *     helper compartido `internal/sales-aggregations.ts` (mismas queries que el
 *     cierre diario, sin divergir).
 *   - GASTOS → `fetchExpensesTotal` (excluye carrier_payments por construcción).
 *   - CARTERA (point-in-time) → `fetchTotalPendingCredits`.
 *   - CAJAS → `fetchCashAccounts` del dashboard (cash_registers/banks/wallets).
 *   - COMPRAS / TRANSPORTISTAS → queries propias sobre purchases /
 *     purchase_credits / purchase_payments / carrier_payments.
 *
 * --------------------------------------------------------------------------
 * Zona horaria (regla del proyecto)
 * --------------------------------------------------------------------------
 *
 * Usa `parseDateRange` (America/Bogota), NO `parseUtcRange`. El rango [from, to]
 * son días COLOMBIANOS. Defaults: `from` = primer día del mes actual (Colombia),
 * `to` = hoy (Colombia).
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * TODAS las queries (helper + propias) filtran por `company_id = $1`. El test
 * cubre este invariante.
 */
@Injectable()
export class GetExtendedSummaryAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    companyId: number,
    fromInput?: string,
    toInput?: string,
  ): Promise<ExtendedSummaryResult> {
    // Defaults en hora Colombia: from = primer día del mes actual, to = hoy.
    const fromStr = fromInput ?? startOfMonthUtc();
    const toStr = toInput ?? todayUtc();
    const { from, to, dateStart, dateEnd } = parseDateRange(fromStr, toStr);
    const cid = String(companyId);

    // ── Ventas (reutiliza el helper compartido del cierre) ──────────────────
    const [salesData, creditNotesData, debitNotesData, consigData, newCreditsData, expensesTotal] =
      await Promise.all([
        fetchCashSales(this.dataSource, cid, dateStart, dateEnd),
        fetchCashNotes(this.dataSource, cid, 'CREDIT', dateStart, dateEnd),
        fetchCashNotes(this.dataSource, cid, 'DEBIT', dateStart, dateEnd),
        fetchTransferSales(this.dataSource, cid, dateStart, dateEnd),
        fetchNewCredits(this.dataSource, cid, dateStart, dateEnd),
        fetchExpensesTotal(this.dataSource, cid, dateStart, dateEnd),
      ]);

    const { netSales, netProfit } = computeNetCashSales(salesData, creditNotesData, debitNotesData);
    const efectivo = round2(netSales);
    const electronico = round2(consigData.totals.consig_total);
    const credito = round2(newCreditsData.new_credits_total);
    const consignacionesProfit = computeConsignacionesProfit(consigData.totals);

    const ventasTotal = round2(
      toBig(efectivo).plus(toBig(electronico)).plus(toBig(credito)).toNumber(),
    );
    // Ganancia de VENTAS del rango = utilidad de contado (neta NC/ND) +
    // utilidad de consignaciones. Espejo del `salesProfit` del cierre.
    const ventasGanancia = round2(toBig(netProfit).plus(toBig(consignacionesProfit)).toNumber());
    // Margen sobre el total de ventas (efectivo + electrónico + crédito).
    const margen =
      ventasTotal > 0 ? round2(toBig(ventasGanancia).div(ventasTotal).times(100).toNumber()) : 0;

    const gastosTotal = round2(expensesTotal);
    const gananciaReal = round2(toBig(ventasGanancia).minus(toBig(gastosTotal)).toNumber());

    // ── Cartera (point-in-time) + Cajas + Compras/Transportistas ────────────
    const [pendingCredits, cashAccounts, purchasesData] = await Promise.all([
      fetchTotalPendingCredits(this.dataSource, cid),
      fetchCashAccounts(this.dataSource, companyId),
      this.fetchPurchasesSection(cid, dateStart, dateEnd),
    ]);

    return {
      from,
      to,
      ventas: {
        efectivo,
        electronico,
        credito,
        total: ventasTotal,
        ganancia: ventasGanancia,
        margen,
      },
      gastos: { total: gastosTotal },
      gananciaReal,
      cartera: {
        balance: round2(pendingCredits.balance),
        count: Number(pendingCredits.pending_count),
      },
      compras: purchasesData,
      cajas: {
        registros: cashAccounts.cashRegisters.map((r) => ({
          id: r.id,
          nombre: r.userName,
          balance: r.balance,
        })),
        bancos: cashAccounts.banks.map((b) => ({
          id: b.id,
          nombre: b.name,
          balance: b.balance,
        })),
        wallets: cashAccounts.wallets.map((w) => ({
          id: w.id,
          nombre: w.name,
          balance: w.balance,
        })),
        totales: {
          cajas: cashAccounts.totals.cashRegisters,
          bancos: cashAccounts.totals.banks,
          wallets: cashAccounts.totals.wallets,
          total: cashAccounts.totals.grand,
        },
      },
    };
  }

  // ─── Compras / transportistas (queries propias, company_id = $1) ───────────

  /**
   * Sección `compras`. Combina:
   *   - total: SUM(purchases.total) en el rango (no borradas).
   *   - recibidas / noRecibidas: conteo y total por status en el rango.
   *   - pagosElectronicos / pagosEfectivo: SUM(purchase_payments.amount) por
   *     método en el rango.
   *   - saldosPorPagar (point-in-time): SUM(purchase_credits.balance) con
   *     status != PAID. Sin rango.
   *   - abonosTransportistas: SUM(carrier_payments.amount) en el rango.
   *   - abonosTransportistasPendientes (point-in-time): SUM(transport_cost) de
   *     compras con transportista que aún no se reciben (status <> RECEIVED).
   */
  private async fetchPurchasesSection(
    cid: string,
    dateStart: Date,
    dateEnd: Date,
  ): Promise<ExtendedSummaryResult['compras']> {
    const [
      totalRow,
      recibidasRow,
      noRecibidasRow,
      paymentsRow,
      saldosRow,
      carrierAbonosRow,
      carrierPendingRow,
    ] = await Promise.all([
      // total de compras del rango (excluye borradas).
      this.dataSource.query<PurchasesTotalRow[]>(
        `
          SELECT COALESCE(SUM(p.total), 0)::float AS total
          FROM purchases p
          WHERE p.company_id = $1
            AND p.is_deleted = false
            AND p.created_at BETWEEN $2 AND $3
          `,
        [cid, dateStart, dateEnd],
      ),
      // recibidas en el rango.
      this.dataSource.query<PurchasesByStatusRow[]>(
        `
          SELECT
            COUNT(*) AS count,
            COALESCE(SUM(p.total), 0)::float AS total
          FROM purchases p
          WHERE p.company_id = $1
            AND p.is_deleted = false
            AND p.status = 'RECEIVED'
            AND p.created_at BETWEEN $2 AND $3
          `,
        [cid, dateStart, dateEnd],
      ),
      // no recibidas (status <> RECEIVED) en el rango.
      this.dataSource.query<PurchasesByStatusRow[]>(
        `
          SELECT
            COUNT(*) AS count,
            COALESCE(SUM(p.total), 0)::float AS total
          FROM purchases p
          WHERE p.company_id = $1
            AND p.is_deleted = false
            AND p.status <> 'RECEIVED'
            AND p.created_at BETWEEN $2 AND $3
          `,
        [cid, dateStart, dateEnd],
      ),
      // pagos a compras por método en el rango.
      this.dataSource.query<PurchasePaymentsRow[]>(
        `
          SELECT
            COALESCE(SUM(pp.amount) FILTER (WHERE pp.payment_method = 'TRANSFER'), 0)::float AS electronicos,
            COALESCE(SUM(pp.amount) FILTER (WHERE pp.payment_method = 'CASH'), 0)::float AS efectivo
          FROM purchase_payments pp
          WHERE pp.company_id = $1
            AND pp.created_at BETWEEN $2 AND $3
          `,
        [cid, dateStart, dateEnd],
      ),
      // saldos por pagar (point-in-time): créditos de compra no liquidados.
      this.dataSource.query<PurchaseCreditsBalanceRow[]>(
        `
          SELECT COALESCE(SUM(pc.balance), 0)::float AS balance
          FROM purchase_credits pc
          WHERE pc.company_id = $1
            AND pc.status <> 'PAID'
          `,
        [cid],
      ),
      // abonos a transportistas en el rango.
      this.dataSource.query<CarrierPaymentsRow[]>(
        `
          SELECT COALESCE(SUM(cp.amount), 0)::float AS abonos
          FROM carrier_payments cp
          WHERE cp.company_id = $1
            AND cp.created_at BETWEEN $2 AND $3
          `,
        [cid, dateStart, dateEnd],
      ),
      // abonos a transportistas PENDIENTES (point-in-time): compras con
      // transportista (carrier_id NOT NULL) que aún no llegan (status <>
      // RECEIVED). Es el flete comprometido cuya mercancía sigue en tránsito.
      this.dataSource.query<CarrierPendingRow[]>(
        `
          SELECT COALESCE(SUM(p.transport_cost), 0)::float AS pendientes
          FROM purchases p
          WHERE p.company_id = $1
            AND p.is_deleted = false
            AND p.carrier_id IS NOT NULL
            AND p.status <> 'RECEIVED'
          `,
        [cid],
      ),
    ]);

    return {
      total: round2(totalRow[0]?.total ?? 0),
      saldosPorPagar: round2(saldosRow[0]?.balance ?? 0),
      pagosElectronicos: round2(paymentsRow[0]?.electronicos ?? 0),
      pagosEfectivo: round2(paymentsRow[0]?.efectivo ?? 0),
      recibidas: {
        count: Number(recibidasRow[0]?.count ?? 0),
        total: round2(recibidasRow[0]?.total ?? 0),
      },
      noRecibidas: {
        count: Number(noRecibidasRow[0]?.count ?? 0),
        total: round2(noRecibidasRow[0]?.total ?? 0),
      },
      abonosTransportistas: round2(carrierAbonosRow[0]?.abonos ?? 0),
      abonosTransportistasPendientes: round2(carrierPendingRow[0]?.pendientes ?? 0),
    };
  }
}
