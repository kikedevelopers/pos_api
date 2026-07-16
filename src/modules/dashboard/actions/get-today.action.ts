import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import {
  fetchExpensesTotal,
  fetchNewCredits,
  fetchPaymentsTotal,
  fetchPurchasePaymentsToday,
  fetchPurchasesToday,
  fetchSalesCount,
  fetchSalesNotesAdjustment,
  fetchSupplierDebt,
  fetchTodayCreditsBalance,
  round2,
} from '../internal/aggregations';
import { fetchCashAccounts, type CashAccountsResult } from '../internal/cash-accounts';
import { parseDateRange, todayUtc } from '../internal/date-range';
import { computeTodayTotals } from '../internal/today-orders';
import {
  fetchAbonoCollectedProfit,
  fetchCollectedProfit,
} from '@/modules/financial-facts/internal/collection-facts';
import { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import {
  computeOrdersProfit,
  EMPTY_ORDERS_BILLING,
  fetchOrdersBilling,
} from '@/modules/reports/internal/sales-aggregations';

/**
 * Output del endpoint `GET /dashboard/today`. Resumen consolidado del día.
 * Espejo PlacePos `TodaySummaryPayload` (`dashboard.routes.ts:660`).
 *
 * Convenciones (paridad PlacePos):
 *   - `cashSales` / `transferSales` = pagos a ventas REGULARES (no crédito)
 *     ajustados por notas (NC resta, ND suma) del mismo día.
 *   - `creditPaymentsCash` / `creditPaymentsTransfer` = abonos recibidos a
 *     invoices a crédito (Activos del día).
 *   - `newCredits` = créditos GENERADOS (Pasivos): conteo + total.
 *   - `realProfit` = `profit - expenses` (gastos NUNCA tocan recaudo).
 *   - `ordersTotal` = facturación de pedidos del día (flag
 *     `include_orders_in_reports`; 0 cuando está OFF). Con el flag ON el pedido
 *     se trata como una venta normal: `ordersTotal` YA ESTÁ SUMADO dentro de
 *     `totalCollected` y su ganancia dentro de `profit`. Se expone aparte solo
 *     para poder mostrarlo DISCRIMINADO. Ver `internal/today-orders.ts`.
 *   - `surplus` = `totalCollected - profit` (excedente / reinversión).
 *   - `purchases.*` = compras del día + abonos a proveedores +
 *     `supplierDebt` (cartera).
 *   - `cashAccounts` = balances actuales de cajas, bancos y billeteras.
 */
export interface TodayResult {
  date: string;
  cashSales: number;
  transferSales: number;
  creditPaymentsCash: number;
  creditPaymentsTransfer: number;
  creditPaymentsTotal: number;
  totalCollected: number;
  ordersTotal: number;
  // ── Vista VENTAS del día (DEVENGADO): una venta a crédito es una venta más.
  //    Alimenta "Resumen de ventas del día", "Descomposición patrimonial" y las
  //    tarjetas de Finanzas (Ganancia real/Excedente). NO tocan la caja
  //    (totalCollected/profit/surplus/realProfit siguen base caja para Meta del
  //    mes y el contrato canónico). ──
  creditSales: number; // valor íntegro de los créditos generados hoy (= newCredits.total)
  totalSales: number; // cashSales + transferSales + creditSales + ordersTotal (Total Ventas del día)
  salesProfit: number; // ganancia DEVENGADA del día = contado + crédito + pedidos
  salesSurplus: number; // totalSales − salesProfit (excedente/reinversión devengado)
  salesRealProfit: number; // salesProfit − gastos (ganancia real devengada)
  profit: number; // CAJA (cobrada): la usa la Meta del mes / patrimonio en caja
  surplus: number; // CAJA
  expenses: number;
  realProfit: number; // CAJA
  salesCount: number;
  // `profit` del crédito = ganancia DEVENGADA de los créditos del día (discriminada).
  newCredits: { count: number; total: number; profit: number };
  purchases: {
    count: number;
    total: number;
    paymentsCash: number;
    paymentsTransfer: number;
    paymentsTotal: number;
    supplierDebt: number;
    todayCreditsBalance: number;
  };
  cashAccounts: CashAccountsResult;
}

/**
 * `GET /dashboard/today?date=YYYY-MM-DD`.
 *
 * Multi-tenancy: cada helper en `aggregations.ts` y `cash-accounts.ts` filtra
 * `company_id = $1`. SELECT puro — no requiere transacción.
 */
@Injectable()
export class GetTodayAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly getIncludeOrdersInReports: GetIncludeOrdersInReportsAction,
  ) {}

  async execute(companyId: number, dateInput?: string): Promise<TodayResult> {
    const today = dateInput ?? todayUtc();
    // parseDateRange con from=to válida el formato y el límite (1 día).
    const range = parseDateRange(today, today);

    const [
      salesCash,
      salesTransfer,
      ncCash,
      ndCash,
      ncTransfer,
      ndTransfer,
      creditsCash,
      creditsTransfer,
      expensesTotal,
      newCredits,
      salesCount,
      purchasesToday,
      purchasePaymentsCashAmt,
      purchasePaymentsTransferAmt,
      supplierDebt,
      todayCreditsBalance,
      cashAccounts,
      collectedProfitValue,
      abonoCollectedProfitValue,
    ] = await Promise.all([
      fetchPaymentsTotal(this.dataSource, companyId, 'CASH', false, range.dateStart, range.dateEnd),
      fetchPaymentsTotal(
        this.dataSource,
        companyId,
        'TRANSFER',
        false,
        range.dateStart,
        range.dateEnd,
      ),
      fetchSalesNotesAdjustment(
        this.dataSource,
        companyId,
        'CASH',
        'CREDIT',
        range.dateStart,
        range.dateEnd,
      ),
      fetchSalesNotesAdjustment(
        this.dataSource,
        companyId,
        'CASH',
        'DEBIT',
        range.dateStart,
        range.dateEnd,
      ),
      fetchSalesNotesAdjustment(
        this.dataSource,
        companyId,
        'TRANSFER',
        'CREDIT',
        range.dateStart,
        range.dateEnd,
      ),
      fetchSalesNotesAdjustment(
        this.dataSource,
        companyId,
        'TRANSFER',
        'DEBIT',
        range.dateStart,
        range.dateEnd,
      ),
      fetchPaymentsTotal(this.dataSource, companyId, 'CASH', true, range.dateStart, range.dateEnd),
      fetchPaymentsTotal(
        this.dataSource,
        companyId,
        'TRANSFER',
        true,
        range.dateStart,
        range.dateEnd,
      ),
      fetchExpensesTotal(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchNewCredits(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchSalesCount(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchPurchasesToday(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchPurchasePaymentsToday(
        this.dataSource,
        companyId,
        'CASH',
        range.dateStart,
        range.dateEnd,
      ),
      fetchPurchasePaymentsToday(
        this.dataSource,
        companyId,
        'TRANSFER',
        range.dateStart,
        range.dateEnd,
      ),
      fetchSupplierDebt(this.dataSource, companyId),
      fetchTodayCreditsBalance(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchCashAccounts(this.dataSource, companyId),
      fetchCollectedProfit(this.dataSource, companyId, range.dateStart, range.dateEnd),
      // Utilidad cobrada SOLO de abonos (para aislar la utilidad de CONTADO:
      // collected − abonos = contado). Se usa en la ganancia DEVENGADA del día.
      fetchAbonoCollectedProfit(this.dataSource, companyId, range.dateStart, range.dateEnd),
    ]);

    const cashSales = round2(toBig(salesCash).minus(toBig(ncCash)).plus(toBig(ndCash)).toNumber());
    const transferSales = round2(
      toBig(salesTransfer).minus(toBig(ncTransfer)).plus(toBig(ndTransfer)).toNumber(),
    );
    const creditPaymentsCash = round2(creditsCash);
    const creditPaymentsTransfer = round2(creditsTransfer);
    const creditPaymentsTotal = round2(
      toBig(creditPaymentsCash).plus(toBig(creditPaymentsTransfer)).toNumber(),
    );

    const collectedCash = round2(
      toBig(cashSales)
        .plus(toBig(transferSales))
        .plus(toBig(creditPaymentsCash))
        .plus(toBig(creditPaymentsTransfer))
        .toNumber(),
    );

    const expenses = round2(expensesTotal);

    // Flag `include_orders_in_reports`: con él activo el pedido se trata como una
    // venta normal (suma al recaudo y su ganancia a la del día). El delta se suma
    // AQUÍ, en el action: `fetchCollectedProfit` es la ganancia cobrada canónica
    // (base caja) y NO se toca. Ver financial-facts/contracts/metrics-spec.md.
    const includeOrders = await this.getIncludeOrdersInReports.execute(companyId);
    const ordersData = includeOrders.enabled
      ? await fetchOrdersBilling(this.dataSource, String(companyId), range.dateStart, range.dateEnd)
      : EMPTY_ORDERS_BILLING;
    const ordersTotal = round2(ordersData.orders_total);
    const ordersProfit = computeOrdersProfit(ordersData);

    const { totalCollected, profit, surplus, realProfit } = computeTodayTotals({
      collectedCash,
      ordersTotal,
      collectedProfit: collectedProfitValue,
      ordersProfit,
      expenses,
    });

    const purchasePaymentsCash = round2(purchasePaymentsCashAmt);
    const purchasePaymentsTransfer = round2(purchasePaymentsTransferAmt);
    const purchasePaymentsTotal = round2(
      toBig(purchasePaymentsCash).plus(toBig(purchasePaymentsTransfer)).toNumber(),
    );

    // ── Vista VENTAS del día (DEVENGADO) ──────────────────────────────────────
    // Una venta a crédito es una venta más: su valor y ganancia íntegros entran
    // el día de la venta. Estos números alimentan el "Resumen de ventas del día",
    // la "Descomposición patrimonial" y las tarjetas de Finanzas (Ganancia real /
    // Excedente). Los abonos ("Recaudo de Cartera") quedan APARTE (no entran).
    // La CAJA (totalCollected/profit/surplus/realProfit) NO cambia: la usa la
    // "Meta del mes" (dinero real) y el contrato canónico.
    const creditSales = round2(newCredits.amount);
    const newCreditsProfit = round2(newCredits.profit);
    const totalSales = round2(
      toBig(cashSales)
        .plus(toBig(transferSales))
        .plus(toBig(creditSales))
        .plus(toBig(ordersTotal))
        .toNumber(),
    );
    // Utilidad de CONTADO (cobrada de contado, sin abonos) = collected − abonos.
    const contadoProfit = round2(
      toBig(collectedProfitValue).minus(toBig(abonoCollectedProfitValue)).toNumber(),
    );
    // Ganancia DEVENGADA del día = contado + crédito íntegro + pedidos.
    const salesProfit = round2(
      toBig(contadoProfit).plus(toBig(newCreditsProfit)).plus(toBig(ordersProfit)).toNumber(),
    );
    const salesSurplus = round2(toBig(totalSales).minus(toBig(salesProfit)).toNumber());
    const salesRealProfit = round2(toBig(salesProfit).minus(toBig(expenses)).toNumber());

    return {
      date: today,
      cashSales,
      transferSales,
      creditPaymentsCash,
      creditPaymentsTransfer,
      creditPaymentsTotal,
      totalCollected,
      ordersTotal,
      creditSales,
      totalSales,
      salesProfit,
      salesSurplus,
      salesRealProfit,
      profit,
      surplus,
      expenses,
      realProfit,
      salesCount,
      newCredits: {
        count: newCredits.count,
        total: creditSales,
        profit: newCreditsProfit,
      },
      purchases: {
        count: purchasesToday.count,
        total: round2(purchasesToday.amount),
        paymentsCash: purchasePaymentsCash,
        paymentsTransfer: purchasePaymentsTransfer,
        paymentsTotal: purchasePaymentsTotal,
        supplierDebt: round2(supplierDebt),
        todayCreditsBalance: round2(todayCreditsBalance),
      },
      cashAccounts,
    };
  }
}
