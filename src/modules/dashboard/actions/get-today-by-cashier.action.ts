import { Injectable } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import {
  fetchAbonosByCashier,
  fetchCreditPaymentsProfitShareByCashier,
  fetchNewCreditsByCashier,
  fetchNotesByCashier,
  fetchSalesByCashier,
  fetchSalesCountByCashier,
  fetchSalesProfitByCashier,
} from '../internal/cashier-aggregations';
import { round2 } from '../internal/aggregations';
import { parseDateRange, todayUtc } from '../internal/date-range';

/**
 * Resumen del día agregado por cajero. Espejo PlacePos byte-por-byte:
 *
 *   - `cashSales` / `transferSales`: ventas regulares (no crédito) por
 *     método, ajustadas por NC/ND prorrateadas según los pagos.
 *   - `creditPaymentsCash` / `creditPaymentsTransfer`: abonos a invoices a
 *     crédito atribuidos al cajero que firmó el PAGO (no el de la venta).
 *   - `creditPaymentsTotal`: suma de los dos anteriores.
 *   - `totalCollected`: cashSales + transferSales + creditPayments*.
 *   - `profit`: profit propio de las V regulares (con NC/ND aplicadas) +
 *     share proporcional del profit de las V-credit a través de los abonos.
 *   - `margin`: profit / totalCollected * 100. 0 si no hay recaudo.
 *   - `surplus`: totalCollected - profit (excedente, NO es ganancia).
 *   - `salesCount`: número de tickets V emitidos por el cajero.
 *   - `newCredits`: { count, total } de créditos generados.
 */
export interface CashierSummary {
  userId: number;
  userName: string;
  cashSales: number;
  transferSales: number;
  creditPaymentsCash: number;
  creditPaymentsTransfer: number;
  creditPaymentsTotal: number;
  totalCollected: number;
  profit: number;
  margin: number;
  surplus: number;
  salesCount: number;
  newCredits: { count: number; total: number };
}

/**
 * Output del endpoint `GET /dashboard/today-by-cashier?date=YYYY-MM-DD`.
 * `cashiers` ordenado por `totalCollected` descendente. `totals` consolida
 * todas las filas devueltas.
 */
export interface TodayByCashierResult {
  date: string;
  cashiers: CashierSummary[];
  totals: {
    cashSales: number;
    transferSales: number;
    creditPaymentsCash: number;
    creditPaymentsTransfer: number;
    creditPaymentsTotal: number;
    totalCollected: number;
    profit: number;
    margin: number;
    surplus: number;
    salesCount: number;
    newCreditsCount: number;
    newCreditsTotal: number;
  };
}

interface Bucket {
  userId: number;
  userName: string;
  cashSales: Big;
  transferSales: Big;
  profitSales: Big;
  creditPaymentsCash: Big;
  creditPaymentsTransfer: Big;
  profitCredits: Big;
  salesCount: number;
  newCreditsCount: number;
  newCreditsTotal: Big;
}

/**
 * `GET /dashboard/today-by-cashier`.
 *
 * Multi-tenancy: cada query en `cashier-aggregations.ts` filtra
 * `company_id = $1` en TODAS las tablas involucradas.
 *
 * SELECT puro — no requiere transacción.
 */
@Injectable()
export class GetTodayByCashierAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, dateInput?: string): Promise<TodayByCashierResult> {
    const today = dateInput ?? todayUtc();
    // parseDateRange con from=to valida formato y descarta fechas inválidas.
    const range = parseDateRange(today, today);

    const [
      salesRows,
      salesProfitRows,
      notesRows,
      abonosRows,
      abonosProfitShare,
      newCreditsRows,
      salesCountByUser,
    ] = await Promise.all([
      fetchSalesByCashier(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchSalesProfitByCashier(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchNotesByCashier(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchAbonosByCashier(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchCreditPaymentsProfitShareByCashier(
        this.dataSource,
        companyId,
        range.dateStart,
        range.dateEnd,
      ),
      fetchNewCreditsByCashier(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchSalesCountByCashier(this.dataSource, companyId, range.dateStart, range.dateEnd),
    ]);

    const byUser = new Map<number, Bucket>();
    const ensure = (userId: number | null, userName: string): Bucket => {
      // pg entrega `bigint` (created_by_id) como STRING. Unas queries keyean con
      // string ("6") y otras (salesCount/abonosProfitShare) con Number(6). Como
      // un Map distingue "6" de 6, el mismo cajero se partía en DOS: uno con
      // nombre+recaudo y otro "Sin asignar" con el conteo. Coercemos SIEMPRE a
      // número para unificar la clave.
      const key = userId == null ? 0 : Number(userId);
      const existing = byUser.get(key);
      if (existing) {
        // Promueve el nombre si veníamos del fallback "Sin asignar".
        if (existing.userName === 'Sin asignar' && userName) {
          existing.userName = userName;
        }
        return existing;
      }
      const fresh: Bucket = {
        userId: key,
        userName: userName || 'Sin asignar',
        cashSales: new Big(0),
        transferSales: new Big(0),
        profitSales: new Big(0),
        creditPaymentsCash: new Big(0),
        creditPaymentsTransfer: new Big(0),
        profitCredits: new Big(0),
        salesCount: 0,
        newCreditsCount: 0,
        newCreditsTotal: new Big(0),
      };
      byUser.set(key, fresh);
      return fresh;
    };

    for (const row of salesRows) {
      const b = ensure(row.user_id, row.user_name);
      b.cashSales = b.cashSales.plus(toBig(row.cash_total));
      b.transferSales = b.transferSales.plus(toBig(row.transfer_total));
    }

    for (const row of salesProfitRows) {
      const b = ensure(row.user_id, '');
      b.profitSales = b.profitSales.plus(toBig(row.profit_total));
    }

    for (const row of notesRows) {
      const b = ensure(row.user_id, row.user_name);
      const cash = toBig(row.cash_total);
      const transfer = toBig(row.transfer_total);
      const profit = toBig(row.profit_total);
      if (row.note_type === 'CREDIT') {
        b.cashSales = b.cashSales.minus(cash);
        b.transferSales = b.transferSales.minus(transfer);
        b.profitSales = b.profitSales.minus(profit);
      } else {
        b.cashSales = b.cashSales.plus(cash);
        b.transferSales = b.transferSales.plus(transfer);
        b.profitSales = b.profitSales.plus(profit);
      }
    }

    for (const row of abonosRows) {
      const b = ensure(row.user_id, row.user_name);
      b.creditPaymentsCash = b.creditPaymentsCash.plus(toBig(row.cash_total));
      b.creditPaymentsTransfer = b.creditPaymentsTransfer.plus(toBig(row.transfer_total));
    }

    for (const [userId, profitShare] of abonosProfitShare.entries()) {
      const b = ensure(userId, '');
      b.profitCredits = b.profitCredits.plus(profitShare);
    }

    for (const row of newCreditsRows) {
      const b = ensure(row.user_id, row.user_name);
      b.newCreditsCount += Number(row.count);
      b.newCreditsTotal = b.newCreditsTotal.plus(toBig(row.amount));
    }

    for (const [userId, count] of salesCountByUser.entries()) {
      const b = ensure(userId, '');
      b.salesCount += count;
    }

    const cashiers: CashierSummary[] = Array.from(byUser.values())
      .filter(
        (b) =>
          !b.cashSales.eq(0) ||
          !b.transferSales.eq(0) ||
          !b.creditPaymentsCash.eq(0) ||
          !b.creditPaymentsTransfer.eq(0) ||
          b.salesCount > 0 ||
          b.newCreditsCount > 0,
      )
      .map((b) => {
        const cashSales = round2(b.cashSales.toNumber());
        const transferSales = round2(b.transferSales.toNumber());
        const creditPaymentsCash = round2(b.creditPaymentsCash.toNumber());
        const creditPaymentsTransfer = round2(b.creditPaymentsTransfer.toNumber());
        const creditPaymentsTotal = round2(
          b.creditPaymentsCash.plus(b.creditPaymentsTransfer).toNumber(),
        );
        const totalCollected = round2(
          b.cashSales
            .plus(b.transferSales)
            .plus(b.creditPaymentsCash)
            .plus(b.creditPaymentsTransfer)
            .toNumber(),
        );
        const profit = round2(b.profitSales.plus(b.profitCredits).toNumber());
        const surplus = round2(toBig(totalCollected).minus(toBig(profit)).toNumber());
        const margin =
          totalCollected > 0
            ? round2(toBig(profit).div(toBig(totalCollected)).times(100).toNumber())
            : 0;
        return {
          userId: b.userId,
          userName: b.userName,
          cashSales,
          transferSales,
          creditPaymentsCash,
          creditPaymentsTransfer,
          creditPaymentsTotal,
          totalCollected,
          profit,
          margin,
          surplus,
          salesCount: b.salesCount,
          newCredits: {
            count: b.newCreditsCount,
            total: round2(b.newCreditsTotal.toNumber()),
          },
        };
      })
      .sort((a, b) => b.totalCollected - a.totalCollected);

    const totalsAcc = cashiers.reduce(
      (acc, c) => ({
        cashSales: acc.cashSales.plus(c.cashSales),
        transferSales: acc.transferSales.plus(c.transferSales),
        creditPaymentsCash: acc.creditPaymentsCash.plus(c.creditPaymentsCash),
        creditPaymentsTransfer: acc.creditPaymentsTransfer.plus(c.creditPaymentsTransfer),
        totalCollected: acc.totalCollected.plus(c.totalCollected),
        profit: acc.profit.plus(c.profit),
        salesCount: acc.salesCount + c.salesCount,
        newCreditsCount: acc.newCreditsCount + c.newCredits.count,
        newCreditsTotal: acc.newCreditsTotal.plus(c.newCredits.total),
      }),
      {
        cashSales: new Big(0),
        transferSales: new Big(0),
        creditPaymentsCash: new Big(0),
        creditPaymentsTransfer: new Big(0),
        totalCollected: new Big(0),
        profit: new Big(0),
        salesCount: 0,
        newCreditsCount: 0,
        newCreditsTotal: new Big(0),
      },
    );

    const totalCollectedAll = round2(totalsAcc.totalCollected.toNumber());
    const profitAll = round2(totalsAcc.profit.toNumber());
    const marginAll =
      totalCollectedAll > 0
        ? round2(toBig(profitAll).div(toBig(totalCollectedAll)).times(100).toNumber())
        : 0;

    return {
      date: today,
      cashiers,
      totals: {
        cashSales: round2(totalsAcc.cashSales.toNumber()),
        transferSales: round2(totalsAcc.transferSales.toNumber()),
        creditPaymentsCash: round2(totalsAcc.creditPaymentsCash.toNumber()),
        creditPaymentsTransfer: round2(totalsAcc.creditPaymentsTransfer.toNumber()),
        creditPaymentsTotal: round2(
          totalsAcc.creditPaymentsCash.plus(totalsAcc.creditPaymentsTransfer).toNumber(),
        ),
        totalCollected: totalCollectedAll,
        profit: profitAll,
        margin: marginAll,
        surplus: round2(toBig(totalCollectedAll).minus(toBig(profitAll)).toNumber()),
        salesCount: totalsAcc.salesCount,
        newCreditsCount: totalsAcc.newCreditsCount,
        newCreditsTotal: round2(totalsAcc.newCreditsTotal.toNumber()),
      },
    };
  }
}
