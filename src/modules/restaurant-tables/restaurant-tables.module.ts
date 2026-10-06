import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RealtimeModule } from '@/modules/realtime/realtime.module';

import { ArchiveRestaurantTableAction } from './actions/archive-restaurant-table.action';
import { CreateRestaurantTableAction } from './actions/create-restaurant-table.action';
import { FindAllRestaurantTablesAction } from './actions/find-all-restaurant-tables.action';
import { FindRestaurantTableAction } from './actions/find-restaurant-table.action';
import { UpdateRestaurantTableAction } from './actions/update-restaurant-table.action';
import { RestaurantTable } from './entities/restaurant-table.entity';
import { RestaurantTablesController } from './restaurant-tables.controller';
import { RestaurantTablesService } from './restaurant-tables.service';

/**
 * Módulo `restaurant-tables` — CRUD de mesas del módulo Salones y Mesas.
 * Exporta TypeOrmModule para que SalonsModule pueda operar sobre las mesas
 * (crear anclada, anclar, desanclar, archivar en cascada).
 */
@Module({
  imports: [TypeOrmModule.forFeature([RestaurantTable]), RealtimeModule],
  controllers: [RestaurantTablesController],
  providers: [
    RestaurantTablesService,
    FindAllRestaurantTablesAction,
    FindRestaurantTableAction,
    CreateRestaurantTableAction,
    UpdateRestaurantTableAction,
    ArchiveRestaurantTableAction,
  ],
  exports: [RestaurantTablesService, TypeOrmModule],
})
export class RestaurantTablesModule {}
