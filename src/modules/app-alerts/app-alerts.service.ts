import { Injectable } from '@nestjs/common';

import { CountUnreadAlertsAction } from './actions/count-unread-alerts.action';
import {
  FindAllAlertsAction,
  type FindAllAlertsParams,
  type FindAllAlertsResult,
} from './actions/find-all-alerts.action';
import { MarkAlertReadAction } from './actions/mark-alert-read.action';
import {
  MarkAllAlertsReadAction,
  type MarkAllAlertsReadResult,
} from './actions/mark-all-alerts-read.action';

/**
 * Facade delgado del módulo `app-alerts`. ZERO lógica — delega a actions.
 */
@Injectable()
export class AppAlertsService {
  constructor(
    private readonly findAllAction: FindAllAlertsAction,
    private readonly countUnreadAction: CountUnreadAlertsAction,
    private readonly markReadAction: MarkAlertReadAction,
    private readonly markAllReadAction: MarkAllAlertsReadAction,
  ) {}

  findAll(companyId: number, params: FindAllAlertsParams): Promise<FindAllAlertsResult> {
    return this.findAllAction.execute(companyId, params);
  }

  countUnread(companyId: number): Promise<number> {
    return this.countUnreadAction.execute(companyId);
  }

  markRead(id: number, companyId: number): Promise<void> {
    return this.markReadAction.execute(id, companyId);
  }

  markAllRead(companyId: number): Promise<MarkAllAlertsReadResult> {
    return this.markAllReadAction.execute(companyId);
  }
}
