import { Injectable } from '@nestjs/common';

import { FindAllTicketSettingsAction } from './actions/find-all-ticket-settings.action';
import { UpdateTicketSettingAction } from './actions/update-ticket-setting.action';
import type { UpdateTicketSettingDto } from './dto/update-ticket-setting.dto';
import type { TicketSetting } from './entities/ticket-setting.entity';

/**
 * Facade delgado del módulo `ticket-settings`. ZERO lógica — solo delega.
 *
 * `IncrementTicketNumberAction` y `CreateDefaultTicketSettingsAction` NO se
 * exponen aquí: no son endpoints públicos. El primero se inyecta directamente
 * en módulos que crean tickets (sales, purchases, credit-notes). El segundo
 * se inyecta en `RegisterAction` para el seed inicial.
 */
@Injectable()
export class TicketSettingsService {
  constructor(
    private readonly findAllAction: FindAllTicketSettingsAction,
    private readonly updateAction: UpdateTicketSettingAction,
  ) {}

  findAll(companyId: number): Promise<TicketSetting[]> {
    return this.findAllAction.execute(companyId);
  }

  update(id: number, dto: UpdateTicketSettingDto, companyId: number): Promise<TicketSetting> {
    return this.updateAction.execute(id, dto, companyId);
  }
}
