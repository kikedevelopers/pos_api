import { Injectable } from '@nestjs/common';

import type { CreateRestaurantTableDto } from '@/modules/restaurant-tables/dto/create-restaurant-table.dto';
import type { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';

import { ArchiveSalonAction } from './actions/archive-salon.action';
import { AttachTableAction } from './actions/attach-table.action';
import { CreateSalonAction, type SalonCreator } from './actions/create-salon.action';
import {
  CreateSalonTableAction,
  type SalonTableCreator,
} from './actions/create-salon-table.action';
import { DetachTableAction } from './actions/detach-table.action';
import { FindAllSalonsAction, type SalonWithTableCount } from './actions/find-all-salons.action';
import { FindSalonAction, type SalonWithTables } from './actions/find-salon.action';
import { UpdateSalonAction } from './actions/update-salon.action';
import type { CreateSalonDto } from './dto/create-salon.dto';
import type { UpdateSalonDto } from './dto/update-salon.dto';
import type { Salon } from './entities/salon.entity';

/** Facade delgado del dominio `salons`. Solo delega a las actions. */
@Injectable()
export class SalonsService {
  constructor(
    private readonly findAllAction: FindAllSalonsAction,
    private readonly findOneAction: FindSalonAction,
    private readonly createAction: CreateSalonAction,
    private readonly updateAction: UpdateSalonAction,
    private readonly archiveAction: ArchiveSalonAction,
    private readonly createTableAction: CreateSalonTableAction,
    private readonly attachTableAction: AttachTableAction,
    private readonly detachTableAction: DetachTableAction,
  ) {}

  findAll(companyId: number): Promise<SalonWithTableCount[]> {
    return this.findAllAction.execute(companyId);
  }

  findOne(id: number, companyId: number): Promise<SalonWithTables> {
    return this.findOneAction.execute(id, companyId);
  }

  create(dto: CreateSalonDto, companyId: number, createdBy: SalonCreator): Promise<Salon> {
    return this.createAction.execute(dto, companyId, createdBy);
  }

  update(id: number, dto: UpdateSalonDto, companyId: number): Promise<Salon> {
    return this.updateAction.execute(id, dto, companyId);
  }

  archive(id: number, companyId: number): Promise<{ archived: true }> {
    return this.archiveAction.execute(id, companyId);
  }

  createTable(
    salonId: number,
    dto: CreateRestaurantTableDto,
    companyId: number,
    createdBy: SalonTableCreator,
  ): Promise<RestaurantTable> {
    return this.createTableAction.execute(salonId, dto, companyId, createdBy);
  }

  attachTable(salonId: number, tableId: number, companyId: number): Promise<RestaurantTable> {
    return this.attachTableAction.execute(salonId, tableId, companyId);
  }

  detachTable(salonId: number, tableId: number, companyId: number): Promise<RestaurantTable> {
    return this.detachTableAction.execute(salonId, tableId, companyId);
  }
}
