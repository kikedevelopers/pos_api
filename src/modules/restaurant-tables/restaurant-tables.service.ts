import { Injectable } from '@nestjs/common';

import { ArchiveRestaurantTableAction } from './actions/archive-restaurant-table.action';
import {
  CreateRestaurantTableAction,
  type RestaurantTableCreator,
} from './actions/create-restaurant-table.action';
import {
  FindAllRestaurantTablesAction,
  type RestaurantTableScope,
} from './actions/find-all-restaurant-tables.action';
import { FindRestaurantTableAction } from './actions/find-restaurant-table.action';
import { UpdateRestaurantTableAction } from './actions/update-restaurant-table.action';
import type { CreateRestaurantTableDto } from './dto/create-restaurant-table.dto';
import type { UpdateRestaurantTableDto } from './dto/update-restaurant-table.dto';
import type { RestaurantTable } from './entities/restaurant-table.entity';

/** Facade delgado del dominio `restaurant-tables`. Solo delega a las actions. */
@Injectable()
export class RestaurantTablesService {
  constructor(
    private readonly findAllAction: FindAllRestaurantTablesAction,
    private readonly findOneAction: FindRestaurantTableAction,
    private readonly createAction: CreateRestaurantTableAction,
    private readonly updateAction: UpdateRestaurantTableAction,
    private readonly archiveAction: ArchiveRestaurantTableAction,
  ) {}

  findAll(companyId: number, scope: RestaurantTableScope): Promise<RestaurantTable[]> {
    return this.findAllAction.execute(companyId, scope);
  }

  findOne(id: number, companyId: number): Promise<RestaurantTable> {
    return this.findOneAction.execute(id, companyId);
  }

  create(
    dto: CreateRestaurantTableDto,
    companyId: number,
    createdBy: RestaurantTableCreator,
  ): Promise<RestaurantTable> {
    return this.createAction.execute(dto, companyId, createdBy);
  }

  update(id: number, dto: UpdateRestaurantTableDto, companyId: number): Promise<RestaurantTable> {
    return this.updateAction.execute(id, dto, companyId);
  }

  archive(id: number, companyId: number): Promise<{ archived: true }> {
    return this.archiveAction.execute(id, companyId);
  }
}
