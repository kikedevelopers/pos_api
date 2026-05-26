import { Injectable } from '@nestjs/common';

import { ArchiveDeliveryAction } from './actions/archive-delivery.action';
import { CreateDeliveryAction } from './actions/create-delivery.action';
import { CreateDeliveryCompanyAction } from './actions/create-delivery-company.action';
import { FindAllDeliveriesAction } from './actions/find-all-deliveries.action';
import { FindAllDeliveryCompaniesAction } from './actions/find-all-delivery-companies.action';
import { FindDeliveryAction } from './actions/find-delivery.action';
import { FindDeliveryByInvoiceAction } from './actions/find-delivery-by-invoice.action';
import { FindDeliveryCompanyAction } from './actions/find-delivery-company.action';
import { PrefillDeliveryAction } from './actions/prefill-delivery.action';
import { ToggleDeliveryCompanyArchiveAction } from './actions/toggle-delivery-company-archive.action';
import { UpdateDeliveryCompanyAction } from './actions/update-delivery-company.action';
import type { CreateDeliveryDto } from './dto/create-delivery.dto';
import type { CreateDeliveryCompanyDto } from './dto/create-delivery-company.dto';
import type { DeliveryPrefillResponseDto } from './dto/delivery-response.dto';
import type { ListDeliveriesQueryDto } from './dto/list-deliveries-query.dto';
import type { ListDeliveryCompaniesQueryDto } from './dto/list-delivery-companies-query.dto';
import type { UpdateDeliveryCompanyDto } from './dto/update-delivery-company.dto';
import type { Delivery } from './entities/delivery.entity';
import type { DeliveryCompany } from './entities/delivery-company.entity';
import type { DeliveryActor } from './internal/delivery-cash.helper';

export type { DeliveryActor } from './internal/delivery-cash.helper';

/**
 * Facade del módulo `deliveries` (Domiciliarios). ZERO lógica — solo delega a
 * las actions. Cubre los dos sub-dominios: domiciliarios (`delivery_companies`)
 * y domicilios (`deliveries`).
 */
@Injectable()
export class DeliveriesService {
  constructor(
    // delivery-companies
    private readonly findAllDeliveryCompaniesAction: FindAllDeliveryCompaniesAction,
    private readonly findDeliveryCompanyAction: FindDeliveryCompanyAction,
    private readonly createDeliveryCompanyAction: CreateDeliveryCompanyAction,
    private readonly updateDeliveryCompanyAction: UpdateDeliveryCompanyAction,
    private readonly toggleDeliveryCompanyArchiveAction: ToggleDeliveryCompanyArchiveAction,
    // deliveries
    private readonly findAllDeliveriesAction: FindAllDeliveriesAction,
    private readonly findDeliveryAction: FindDeliveryAction,
    private readonly findDeliveryByInvoiceAction: FindDeliveryByInvoiceAction,
    private readonly prefillDeliveryAction: PrefillDeliveryAction,
    private readonly createDeliveryAction: CreateDeliveryAction,
    private readonly archiveDeliveryAction: ArchiveDeliveryAction,
  ) {}

  // ---------------------------------------------------------------------------
  // delivery-companies
  // ---------------------------------------------------------------------------

  findAllCompanies(
    companyId: number,
    query: ListDeliveryCompaniesQueryDto,
  ): Promise<DeliveryCompany[]> {
    return this.findAllDeliveryCompaniesAction.execute(companyId, query);
  }

  findCompany(id: number, companyId: number): Promise<DeliveryCompany> {
    return this.findDeliveryCompanyAction.execute(id, companyId);
  }

  createCompany(
    dto: CreateDeliveryCompanyDto,
    companyId: number,
    actor: DeliveryActor,
  ): Promise<DeliveryCompany> {
    return this.createDeliveryCompanyAction.execute(dto, companyId, actor);
  }

  updateCompany(
    id: number,
    dto: UpdateDeliveryCompanyDto,
    companyId: number,
  ): Promise<DeliveryCompany> {
    return this.updateDeliveryCompanyAction.execute(id, dto, companyId);
  }

  setCompanyArchived(
    id: number,
    companyId: number,
    archived: boolean,
    actorId: number,
  ): Promise<{ archived: boolean }> {
    return this.toggleDeliveryCompanyArchiveAction.execute(id, companyId, archived, actorId);
  }

  // ---------------------------------------------------------------------------
  // deliveries
  // ---------------------------------------------------------------------------

  findAllDeliveries(companyId: number, query: ListDeliveriesQueryDto): Promise<Delivery[]> {
    return this.findAllDeliveriesAction.execute(companyId, query);
  }

  findDelivery(id: number, companyId: number): Promise<Delivery> {
    return this.findDeliveryAction.execute(id, companyId);
  }

  findDeliveryByInvoice(invoiceId: number, companyId: number): Promise<Delivery | null> {
    return this.findDeliveryByInvoiceAction.execute(invoiceId, companyId);
  }

  prefill(invoiceId: number, companyId: number): Promise<DeliveryPrefillResponseDto> {
    return this.prefillDeliveryAction.execute(invoiceId, companyId);
  }

  createDelivery(
    dto: CreateDeliveryDto,
    companyId: number,
    actor: DeliveryActor,
  ): Promise<Delivery> {
    return this.createDeliveryAction.execute(dto, companyId, actor);
  }

  archiveDelivery(
    id: number,
    companyId: number,
    actor: DeliveryActor,
  ): Promise<{ archived: true }> {
    return this.archiveDeliveryAction.execute(id, companyId, actor);
  }
}
