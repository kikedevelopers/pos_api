import { Injectable } from '@nestjs/common';

import type { CreditNote } from '@/modules/credit-notes/entities/credit-note.entity';

import { CreateSaleAction, type SaleCreator } from './actions/create-sale.action';
import { FindAllSalesAction } from './actions/find-all-sales.action';
import { FindSaleAction, type SaleAggregate } from './actions/find-sale.action';
import { GetConsolidatedInvoiceAction } from './actions/get-consolidated-invoice.action';
import { GetConsolidatedInvoiceUpToAction } from './actions/get-consolidated-invoice-upto.action';
import { GetLastSaleAction, type LastSaleResult } from './actions/get-last-sale.action';
import { GetSaleCreditNoteAction } from './actions/get-sale-credit-note.action';
import {
  UpdateSaleNoteAction,
  type UpdateSaleNoteActionResult,
} from './actions/update-sale-note.action';
import {
  UpdateSaleAction,
  type UpdateSaleActionResult,
  type UpdateSaleActor,
} from './actions/update-sale.action';
import {
  VoidSaleAction,
  type VoidSaleActionResult,
  type VoidSaleActor,
} from './actions/void-sale.action';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import type { CreateSaleDto } from './dto/create-sale.dto';
import type { ListSalesQueryDto } from './dto/list-sales-query.dto';
import type { SaleListItemDto } from './dto/sale-list-item.dto';
import type { SaleCorrectionSourceDto, UpdateSaleDto } from './dto/update-sale.dto';
import type { ConsolidatedInvoice } from './internal/consolidate-invoice.helper';

export type { SaleCreator } from './actions/create-sale.action';
export type { SaleAggregate } from './actions/find-sale.action';
export type { SalePaymentActor } from './internal/apply-sale-payment';

/**
 * Facade del módulo `sales`. ZERO lógica — solo delega.
 *
 * Nota Fase 1: los endpoints de pagos y `convert` se eliminaron (paridad
 * PlacePos: la conversión ORDER→SALE pasará a vivir dentro de
 * `POST /payments` en Fase 4). `ConvertOrderToSaleAction` se mantiene como
 * provider del módulo para que otros dominios (credit-notes, payments) la
 * compongan internamente; no se reexpone como método público del facade.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly findAllSalesAction: FindAllSalesAction,
    private readonly findSaleAction: FindSaleAction,
    private readonly createSaleAction: CreateSaleAction,
    private readonly updateSaleAction: UpdateSaleAction,
    private readonly updateSaleNoteAction: UpdateSaleNoteAction,
    private readonly voidSaleAction: VoidSaleAction,
    private readonly getLastSaleAction: GetLastSaleAction,
    private readonly getConsolidatedInvoiceAction: GetConsolidatedInvoiceAction,
    private readonly getConsolidatedInvoiceUpToAction: GetConsolidatedInvoiceUpToAction,
    private readonly getSaleCreditNoteAction: GetSaleCreditNoteAction,
  ) {}

  findAll(
    companyId: number,
    query: ListSalesQueryDto,
    actor: AuthUser,
  ): Promise<SaleListItemDto[]> {
    return this.findAllSalesAction.execute(companyId, query, actor);
  }

  findOne(id: number, companyId: number): Promise<SaleAggregate> {
    return this.findSaleAction.execute(id, companyId);
  }

  findLast(companyId: number): Promise<LastSaleResult | null> {
    return this.getLastSaleAction.execute(companyId);
  }

  getConsolidated(id: number, companyId: number): Promise<ConsolidatedInvoice | null> {
    return this.getConsolidatedInvoiceAction.execute(id, companyId);
  }

  getConsolidatedUpto(
    id: number,
    noteId: number,
    companyId: number,
  ): Promise<ConsolidatedInvoice | null> {
    return this.getConsolidatedInvoiceUpToAction.execute(id, noteId, companyId);
  }

  getCreditNote(id: number, companyId: number): Promise<CreditNote | null> {
    return this.getSaleCreditNoteAction.execute(id, companyId);
  }

  create(dto: CreateSaleDto, companyId: number, createdBy: SaleCreator): Promise<SaleAggregate> {
    return this.createSaleAction.execute(dto, companyId, createdBy);
  }

  update(
    id: number,
    dto: UpdateSaleDto,
    companyId: number,
    actor: UpdateSaleActor,
  ): Promise<UpdateSaleActionResult> {
    return this.updateSaleAction.execute(id, dto, companyId, actor);
  }

  updateNote(
    invoiceId: number,
    companyId: number,
    notes: string | null,
  ): Promise<UpdateSaleNoteActionResult> {
    return this.updateSaleNoteAction.execute({ invoiceId, companyId, notes });
  }

  void(
    id: number,
    companyId: number,
    actor: VoidSaleActor,
    reason?: string | null,
    refundSource?: SaleCorrectionSourceDto | null,
  ): Promise<VoidSaleActionResult> {
    return this.voidSaleAction.execute(id, companyId, actor, reason, refundSource ?? null);
  }
}
