import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { fetchCashAccounts, type CashAccountsResult } from '@/modules/dashboard/internal/cash-accounts';

/**
 * `GET /treasury/accounts` — saldos ACTUALES de todas las cajas de la company
 * (bancos, billeteras y cajas de cajeros) + subtotales y total general.
 *
 * Reutiliza `fetchCashAccounts` (misma fuente de la verdad que
 * `GET /dashboard/today` → `cashAccounts`), ya scopeado por `company_id`.
 */
@Injectable()
export class GetTreasuryAccountsAction {
  constructor(private readonly dataSource: DataSource) {}

  execute(companyId: number): Promise<CashAccountsResult> {
    return fetchCashAccounts(this.dataSource, companyId);
  }
}
