import { Injectable } from '@nestjs/common';

import { ArchiveCarrierAction } from './actions/archive-carrier.action';
import { CreateCarrierAction, type CarrierCreator } from './actions/create-carrier.action';
import { FindAllCarriersAction, type CarrierListItem } from './actions/find-all-carriers.action';
import { FindCarrierAction, type CarrierDetail } from './actions/find-carrier.action';
import {
  GetCarriersAnalyticsAction,
  type CarriersAnalyticsResult,
} from './actions/get-carriers-analytics.action';
import { UpdateCarrierAction } from './actions/update-carrier.action';
import type { CreateCarrierDto } from './dto/create-carrier.dto';
import type { UpdateCarrierDto } from './dto/update-carrier.dto';
import type { Carrier } from './entities/carrier.entity';

export type { CarrierCreator } from './actions/create-carrier.action';
export type { CarrierListItem } from './actions/find-all-carriers.action';
export type { CarrierDetail } from './actions/find-carrier.action';
export type { CarriersAnalyticsResult } from './actions/get-carriers-analytics.action';

/**
 * Facade del módulo `carriers` — sin lógica, solo delega (CLAUDE.md §3.1).
 */
@Injectable()
export class CarriersService {
  constructor(
    private readonly findAllCarriersAction: FindAllCarriersAction,
    private readonly findCarrierAction: FindCarrierAction,
    private readonly getCarriersAnalyticsAction: GetCarriersAnalyticsAction,
    private readonly createCarrierAction: CreateCarrierAction,
    private readonly updateCarrierAction: UpdateCarrierAction,
    private readonly archiveCarrierAction: ArchiveCarrierAction,
  ) {}

  findAll(companyId: number): Promise<CarrierListItem[]> {
    return this.findAllCarriersAction.execute(companyId);
  }

  findOne(id: number, companyId: number): Promise<CarrierDetail> {
    return this.findCarrierAction.execute(id, companyId);
  }

  getAnalytics(companyId: number): Promise<CarriersAnalyticsResult> {
    return this.getCarriersAnalyticsAction.execute(companyId);
  }

  create(dto: CreateCarrierDto, companyId: number, createdBy: CarrierCreator): Promise<Carrier> {
    return this.createCarrierAction.execute(dto, companyId, createdBy);
  }

  update(id: number, dto: UpdateCarrierDto, companyId: number): Promise<Carrier> {
    return this.updateCarrierAction.execute(id, dto, companyId);
  }

  archive(id: number, companyId: number): Promise<{ archived: true }> {
    return this.archiveCarrierAction.execute(id, companyId);
  }
}
