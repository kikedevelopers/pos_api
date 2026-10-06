import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { fetchCreditsDueToday, type CreditsDueTodaySummary } from '../internal/credits-due-today';

/** Consulta los créditos con saldo que vencen en `date` (YYYY-MM-DD) para una company. */
@Injectable()
export class GetCreditsDueTodayAction {
  constructor(private readonly dataSource: DataSource) {}

  execute(companyId: number, date: string): Promise<CreditsDueTodaySummary> {
    return fetchCreditsDueToday(this.dataSource, companyId, date);
  }
}
