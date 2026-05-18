import { Injectable } from '@nestjs/common';

import { CreateSupplierAction, type SupplierCreator } from './actions/create-supplier.action';
import { FindAllSuppliersAction } from './actions/find-all-suppliers.action';
import { FindSupplierAction } from './actions/find-supplier.action';
import {
  GetSupplierPurchasesHistoryAction,
  type SupplierPurchasesHistoryResponse,
} from './actions/get-supplier-purchases-history.action';
import {
  GetSuppliersAnalyticsAction,
  type SuppliersAnalyticsResponse,
} from './actions/get-suppliers-analytics.action';
import { ToggleSupplierArchiveAction } from './actions/toggle-supplier-archive.action';
import { UpdateSupplierAction } from './actions/update-supplier.action';
import type { CreateSupplierDto } from './dto/create-supplier.dto';
import type { ListSuppliersQueryDto } from './dto/list-suppliers-query.dto';
import type { UpdateSupplierDto } from './dto/update-supplier.dto';
import type { Supplier } from './entities/supplier.entity';

export type { SupplierCreator } from './actions/create-supplier.action';
export type { SuppliersAnalyticsResponse } from './actions/get-suppliers-analytics.action';

/**
 * Facade delgado del dominio `suppliers`. Sin lógica de negocio — solo
 * delega a la action correspondiente (CLAUDE.md §3.1).
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly findAllSuppliersAction: FindAllSuppliersAction,
    private readonly findSupplierAction: FindSupplierAction,
    private readonly createSupplierAction: CreateSupplierAction,
    private readonly updateSupplierAction: UpdateSupplierAction,
    private readonly toggleSupplierArchiveAction: ToggleSupplierArchiveAction,
    private readonly getSupplierPurchasesHistoryAction: GetSupplierPurchasesHistoryAction,
    private readonly getSuppliersAnalyticsAction: GetSuppliersAnalyticsAction,
  ) {}

  getAnalytics(companyId: number): Promise<SuppliersAnalyticsResponse> {
    return this.getSuppliersAnalyticsAction.execute(companyId);
  }

  findAll(companyId: number, query: ListSuppliersQueryDto = {}): Promise<Supplier[]> {
    return this.findAllSuppliersAction.execute(companyId, query);
  }

  findOne(id: number, companyId: number): Promise<Supplier> {
    return this.findSupplierAction.execute(id, companyId);
  }

  create(dto: CreateSupplierDto, companyId: number, createdBy: SupplierCreator): Promise<Supplier> {
    return this.createSupplierAction.execute(dto, companyId, createdBy);
  }

  update(id: number, dto: UpdateSupplierDto, companyId: number): Promise<Supplier> {
    return this.updateSupplierAction.execute(id, dto, companyId);
  }

  archive(id: number, companyId: number, actorId: number): Promise<{ archived: true }> {
    return this.toggleSupplierArchiveAction.execute(id, companyId, actorId);
  }

  getPurchasesHistory(id: number, companyId: number): Promise<SupplierPurchasesHistoryResponse> {
    return this.getSupplierPurchasesHistoryAction.execute(id, companyId);
  }
}
