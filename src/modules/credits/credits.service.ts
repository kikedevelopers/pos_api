import { Injectable } from '@nestjs/common';

import { ListAllCreditsAction, type ListAllCreditsResult } from './actions/list-all-credits.action';
import type { ListCreditsQueryDto } from './dto/list-credits-query.dto';

export type { ListAllCreditsResult } from './actions/list-all-credits.action';

/**
 * Facade del módulo `credits` (agregador). Sin estado — solo delega a la
 * action que ejecuta el UNION ALL.
 */
@Injectable()
export class CreditsService {
  constructor(private readonly listAllCreditsAction: ListAllCreditsAction) {}

  listAll(companyId: number, query: ListCreditsQueryDto): Promise<ListAllCreditsResult> {
    return this.listAllCreditsAction.execute(companyId, query);
  }
}
