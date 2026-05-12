import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { ListFinancialMovementsAction } from './actions/list-financial-movements.action';
import {
  RecordFinancialMovementAction,
  type RecordFinancialMovementInput,
} from './actions/record-financial-movement.action';
import { AccountReference, FinancialMovement } from './entities/financial-movement.entity';

/**
 * Facade del módulo `financial-movements`. Sin lógica — solo delega.
 *
 * El método `record(manager, input)` se expone para que OTROS módulos
 * (banks.create, accounts.transfer, etc.) lo inyecten y registren
 * movimientos DENTRO de sus propias transacciones. La firma exige el
 * `manager` para forzar atomicidad.
 */
@Injectable()
export class FinancialMovementsService {
  constructor(
    private readonly listFinancialMovementsAction: ListFinancialMovementsAction,
    private readonly recordFinancialMovementAction: RecordFinancialMovementAction,
  ) {}

  list(
    companyId: number,
    accountType: AccountReference,
    accountId: number,
  ): Promise<FinancialMovement[]> {
    return this.listFinancialMovementsAction.execute(companyId, accountType, accountId);
  }

  record(manager: EntityManager, input: RecordFinancialMovementInput): Promise<FinancialMovement> {
    return this.recordFinancialMovementAction.execute(manager, input);
  }
}
