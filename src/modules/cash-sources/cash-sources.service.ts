import { Injectable } from '@nestjs/common';

import { GetCashSourcesAction } from './actions/get-cash-sources.action';
import type { CashSourcesResponseDto } from './dto/cash-sources-response.dto';

/**
 * Facade del módulo `cash-sources` — solo delega.
 */
@Injectable()
export class CashSourcesService {
  constructor(private readonly getCashSourcesAction: GetCashSourcesAction) {}

  get(companyId: number, userId: number): Promise<CashSourcesResponseDto> {
    return this.getCashSourcesAction.execute(companyId, userId);
  }
}
