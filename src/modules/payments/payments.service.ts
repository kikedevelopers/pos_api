import { Injectable } from '@nestjs/common';

import {
  ListAllPaymentsAction,
  type ListAllPaymentsResult,
} from './actions/list-all-payments.action';
import type { ListPaymentsQueryDto } from './dto/list-payments-query.dto';

export type { ListAllPaymentsResult } from './actions/list-all-payments.action';

/**
 * Facade del módulo `payments` (agregador). Solo delega a la action.
 */
@Injectable()
export class PaymentsService {
  constructor(private readonly listAllPaymentsAction: ListAllPaymentsAction) {}

  listAll(companyId: number, query: ListPaymentsQueryDto): Promise<ListAllPaymentsResult> {
    return this.listAllPaymentsAction.execute(companyId, query);
  }
}
