import { Injectable } from '@nestjs/common';

import {
  ListCarrierPaymentsAction,
  type CarrierPaymentListItem,
} from './actions/list-carrier-payments.action';
import {
  ProcessCarrierPaymentAction,
  type CarrierPaymentActor,
} from './actions/process-carrier-payment.action';
import type { CreateCarrierPaymentDto } from './dto/create-carrier-payment.dto';
import type { ListCarrierPaymentsQueryDto } from './dto/list-carrier-payments-query.dto';
import type { CarrierPayment } from './entities/carrier-payment.entity';

export type { CarrierPaymentActor } from './actions/process-carrier-payment.action';
export type { CarrierPaymentListItem } from './actions/list-carrier-payments.action';

/**
 * Facade del módulo `carrier-payments` — patrón §3.1 CLAUDE.md.
 */
@Injectable()
export class CarrierPaymentsService {
  constructor(
    private readonly processCarrierPaymentAction: ProcessCarrierPaymentAction,
    private readonly listCarrierPaymentsAction: ListCarrierPaymentsAction,
  ) {}

  process(
    dto: CreateCarrierPaymentDto,
    companyId: number,
    actor: CarrierPaymentActor,
  ): Promise<CarrierPayment> {
    return this.processCarrierPaymentAction.execute(dto, companyId, actor);
  }

  list(companyId: number, query: ListCarrierPaymentsQueryDto): Promise<CarrierPaymentListItem[]> {
    return this.listCarrierPaymentsAction.execute(companyId, query);
  }
}
