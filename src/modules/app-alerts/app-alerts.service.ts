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
import type { AlertScope } from './internal/alert-scope';

/**
 * Fachada de las alertas. Todo opera sobre un `AlertScope` (negocio activo +,
 * para el dueño, los pedidos del agente de sus otras sucursales).
 */
@Injectable()
export class AppAlertsService {
  constructor(
    private readonly findAllAction: FindAllAlertsAction,
    private readonly countUnreadAction: CountUnreadAlertsAction,
    private readonly markReadAction: MarkAlertReadAction,
    private readonly markAllReadAction: MarkAllAlertsReadAction,
  ) {}

  findAll(scope: AlertScope, params: FindAllAlertsParams): Promise<FindAllAlertsResult> {
    return this.findAllAction.execute(scope, params);
  }

  countUnread(scope: AlertScope): Promise<number> {
    return this.countUnreadAction.execute(scope);
  }

  markRead(id: number, scope: AlertScope): Promise<void> {
    return this.markReadAction.execute(id, scope);
  }

  markAllRead(scope: AlertScope): Promise<MarkAllAlertsReadResult> {
    return this.markAllReadAction.execute(scope);
  }
}
