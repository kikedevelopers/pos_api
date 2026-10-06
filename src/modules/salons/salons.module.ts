import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RealtimeModule } from '@/modules/realtime/realtime.module';

import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';

import { ArchiveSalonAction } from './actions/archive-salon.action';
import { AttachTableAction } from './actions/attach-table.action';
import { CreateSalonAction } from './actions/create-salon.action';
import { CreateSalonTableAction } from './actions/create-salon-table.action';
import { DetachTableAction } from './actions/detach-table.action';
import { FindAllSalonsAction } from './actions/find-all-salons.action';
import { FindSalonAction } from './actions/find-salon.action';
import { UpdateSalonAction } from './actions/update-salon.action';
import { Salon } from './entities/salon.entity';
import { SalonsController } from './salons.controller';
import { SalonsService } from './salons.service';

/**
 * Módulo `salons` — salones (agrupadores de mesas) + anclaje de mesas. Importa
 * también `RestaurantTable` porque sus actions operan sobre las mesas (crear
 * anclada, anclar, desanclar, archivar en cascada).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Salon, RestaurantTable]), RealtimeModule],
  controllers: [SalonsController],
  providers: [
    SalonsService,
    FindAllSalonsAction,
    FindSalonAction,
    CreateSalonAction,
    UpdateSalonAction,
    ArchiveSalonAction,
    CreateSalonTableAction,
    AttachTableAction,
    DetachTableAction,
  ],
  exports: [SalonsService, TypeOrmModule],
})
export class SalonsModule {}
