import { Injectable } from '@nestjs/common';

import type { CashAccountsResult } from '@/modules/dashboard/internal/cash-accounts';

import { GetTreasuryAccountsAction } from './actions/get-treasury-accounts.action';
import { ListTreasuryMovementsAction } from './actions/list-treasury-movements.action';
import type { TreasuryMovementResponseDto } from './dto/treasury-movement-response.dto';

/**
 * Facade del módulo `treasury`. Sin lógica — solo delega en las actions.
 */
@Injectable()
export class TreasuryService {
  constructor(
    private readonly getTreasuryAccountsAction: GetTreasuryAccountsAction,
    private readonly listTreasuryMovementsAction: ListTreasuryMovementsAction,
  ) {}

  accounts(companyId: number): Promise<CashAccountsResult> {
    return this.getTreasuryAccountsAction.execute(companyId);
  }

  movements(companyId: number, from?: string, to?: string): Promise<TreasuryMovementResponseDto[]> {
    return this.listTreasuryMovementsAction.execute(companyId, from, to);
  }
}
