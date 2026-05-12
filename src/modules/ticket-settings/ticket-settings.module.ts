import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CreateDefaultTicketSettingsAction } from './actions/create-default-ticket-settings.action';
import { FindAllTicketSettingsAction } from './actions/find-all-ticket-settings.action';
import { IncrementTicketNumberAction } from './actions/increment-ticket-number.action';
import { UpdateTicketSettingAction } from './actions/update-ticket-setting.action';
import { TicketSetting } from './entities/ticket-setting.entity';
import { TicketSettingsController } from './ticket-settings.controller';
import { TicketSettingsService } from './ticket-settings.service';

/**
 * Módulo `ticket-settings`.
 *
 * Cablea las 4 actions del dominio + service facade.
 *
 * Re-exporta dos actions que no son endpoints públicos:
 *
 *   - `CreateDefaultTicketSettingsAction` — el `RegisterAction` lo inyecta
 *     para seedear las 5 filas iniciales por company durante el registro.
 *
 *   - `IncrementTicketNumberAction` — los módulos que crean tickets
 *     (`sales`, `purchases`, `credit-notes`, `debit-notes`) lo inyectan
 *     para obtener el próximo folio atómicamente dentro de SU transacción.
 *
 * Patrón espejo del `WalletsModule.CreateDefaultWalletAction`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TicketSetting])],
  controllers: [TicketSettingsController],
  providers: [
    TicketSettingsService,
    FindAllTicketSettingsAction,
    UpdateTicketSettingAction,
    IncrementTicketNumberAction,
    CreateDefaultTicketSettingsAction,
  ],
  exports: [
    TicketSettingsService,
    IncrementTicketNumberAction,
    CreateDefaultTicketSettingsAction,
    TypeOrmModule,
  ],
})
export class TicketSettingsModule {}
