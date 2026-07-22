import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { parseUtcRange, todayUtcDate } from '../internal/range';
import { fetchSalesByHour } from '../internal/sales-aggregations';

/** Una hora del día (0–23) con su venta total y el número de tickets. */
export interface SalesByHourEntry {
  hour: number;
  total: number;
  count: number;
}

export interface SalesByHourResult {
  date: string;
  /** SIEMPRE 24 entradas (0–23), zero-fill incluido, ordenadas por hora. */
  hours: SalesByHourEntry[];
  /** Suma de las 24 horas (= venta del día por tickets SALE). */
  total: number;
  /** Total de tickets del día. */
  count: number;
}

/**
 * Venta del día por HORA (hora Colombia), para el gráfico de línea "venta por
 * horas". Devuelve SIEMPRE las 24 horas (0–23) con zero-fill, de modo que el
 * chart pueda pintar el día completo y mostrar en qué horas hubo pico, cuándo
 * empezó a bajar y en qué horas no hubo ventas.
 */
@Injectable()
export class GetSalesByHourAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, dateInput?: string): Promise<SalesByHourResult> {
    const targetDate = dateInput ?? todayUtcDate();
    const { dateStart, dateEnd } = parseUtcRange(targetDate, targetDate);
    const cid = String(companyId);

    const rows = await fetchSalesByHour(this.dataSource, cid, dateStart, dateEnd);
    const byHour = new Map(rows.map((r) => [r.hour, r]));

    const hours: SalesByHourEntry[] = Array.from({ length: 24 }, (_, hour) => {
      const row = byHour.get(hour);
      return { hour, total: row?.total ?? 0, count: row?.count ?? 0 };
    });

    const total = hours.reduce((acc, h) => acc + h.total, 0);
    const count = hours.reduce((acc, h) => acc + h.count, 0);

    return { date: targetDate, hours, total, count };
  }
}
