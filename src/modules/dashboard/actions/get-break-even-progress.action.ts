import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { Company } from '@/modules/companies/entities/company.entity';

import { fetchExpensesTotal, round2 } from '../internal/aggregations';
import { parseDateRange, startOfMonthUtc, todayUtc } from '../internal/date-range';
import { fetchCollectedProfit } from '@/modules/financial-facts/internal/collection-facts';
import { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import {
  computeOrdersProfit,
  EMPTY_ORDERS_BILLING,
  fetchOrdersBilling,
} from '@/modules/reports/internal/sales-aggregations';

/**
 * Output del endpoint `GET /dashboard/break-even-progress`.
 *
 * Cuando `breakEvenAmount = 0` el endpoint regresa `configured: false` para
 * indicarle al front que muestre el banner de configuración.
 */
export interface BreakEvenProgressResult {
  configured: boolean;
  breakEvenAmount: number;
  breakEvenPeriodDays: number;
  dailyTarget: number;
  monthFrom: string;
  monthTo: string;
  monthRealProfit: number;
  monthProgress: number;
  dayRealProfit: number;
  dayProgress: number;
}

/**
 * `GET /dashboard/break-even-progress?date=YYYY-MM-DD`.
 *
 * Calcula la ganancia real (profit - expenses) del día y del mes hasta `date`
 * y la compara con la meta de la company. Espejo PlacePos.
 *
 * Multi-tenancy: `companyRepo.findOne({ where: { id: companyId } })` filtra
 * por el tenant del JWT. `fetchProfitTotal` y `fetchExpensesTotal` filtran
 * por `company_id = $1`.
 */
@Injectable()
export class GetBreakEvenProgressAction {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    private readonly getIncludeOrdersInReports: GetIncludeOrdersInReportsAction,
  ) {}

  async execute(companyId: number, dateInput?: string): Promise<BreakEvenProgressResult> {
    const today = dateInput ?? todayUtc();
    const monthFrom = startOfMonthUtc(today);
    const monthTo = today;

    // Cargamos solo los 3 campos relevantes; el filtro por id ya garantiza
    // el aislamiento de tenant (el JWT viene validado).
    const company = await this.companyRepo.findOne({
      where: { id: String(companyId) },
      select: { id: true, break_even_amount: true, break_even_period_days: true },
    });

    const breakEvenAmount = company ? Number(company.break_even_amount) : 0;
    const breakEvenPeriodDays = company ? Number(company.break_even_period_days) : 30;
    const configured = breakEvenAmount > 0;

    if (!configured) {
      return {
        configured: false,
        breakEvenAmount,
        breakEvenPeriodDays,
        dailyTarget: 0,
        monthFrom,
        monthTo,
        monthRealProfit: 0,
        monthProgress: 0,
        dayRealProfit: 0,
        dayProgress: 0,
      };
    }

    const dayRange = parseDateRange(today, today);
    const monthRange = parseDateRange(monthFrom, monthTo);

    // Flag `include_orders_in_reports`: con él activo el pedido cuenta como una
    // venta normal, así que su ganancia entra en la meta igual que entra en
    // "Ganancia del día". Coherente con `GetTodayAction`: si el dashboard dice
    // que hoy ganaste X, la meta debe medirse contra ese mismo X.
    const includeOrders = await this.getIncludeOrdersInReports.execute(companyId);
    const cid = String(companyId);

    const [dayProfit, dayExpenses, monthProfit, monthExpenses, dayOrders, monthOrders] =
      await Promise.all([
        fetchCollectedProfit(this.dataSource, companyId, dayRange.dateStart, dayRange.dateEnd),
        fetchExpensesTotal(this.dataSource, companyId, dayRange.dateStart, dayRange.dateEnd),
        fetchCollectedProfit(this.dataSource, companyId, monthRange.dateStart, monthRange.dateEnd),
        fetchExpensesTotal(this.dataSource, companyId, monthRange.dateStart, monthRange.dateEnd),
        includeOrders.enabled
          ? fetchOrdersBilling(this.dataSource, cid, dayRange.dateStart, dayRange.dateEnd)
          : Promise.resolve(EMPTY_ORDERS_BILLING),
        includeOrders.enabled
          ? fetchOrdersBilling(this.dataSource, cid, monthRange.dateStart, monthRange.dateEnd)
          : Promise.resolve(EMPTY_ORDERS_BILLING),
      ]);

    const dailyTarget = round2(toBig(breakEvenAmount).div(breakEvenPeriodDays).toNumber());
    const dayRealProfit = round2(
      toBig(dayProfit)
        .plus(toBig(computeOrdersProfit(dayOrders)))
        .minus(toBig(dayExpenses))
        .toNumber(),
    );
    const monthRealProfit = round2(
      toBig(monthProfit)
        .plus(toBig(computeOrdersProfit(monthOrders)))
        .minus(toBig(monthExpenses))
        .toNumber(),
    );
    // Los ratios de progreso se redondean a 4 decimales (no a 2): redondear a 2
    // da granularidad de 1% y haría que, p. ej., 0.9975 (99.75%) se redondee a
    // 1.00, marcando falsamente la meta como alcanzada (isReached / "Meta
    // superada"). Con 4 decimales se conserva la precisión y el progreso real.
    const monthProgress = toBig(monthRealProfit).div(breakEvenAmount).round(4).toNumber();
    const dayProgress =
      dailyTarget > 0 ? toBig(dayRealProfit).div(dailyTarget).round(4).toNumber() : 0;

    return {
      configured: true,
      breakEvenAmount,
      breakEvenPeriodDays,
      dailyTarget,
      monthFrom,
      monthTo,
      monthRealProfit,
      monthProgress,
      dayRealProfit,
      dayProgress,
    };
  }
}
