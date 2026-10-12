import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { assignNextTurn } from '../internal/turnos-config';

/**
 * Asigna el próximo TURNO de pedido para la company, o `null` si la feature
 * está deshabilitada. Recibe el `EntityManager` del caller para correr DENTRO
 * de la transacción de creación del pedido (si el pedido hace rollback, el
 * turno no se quema). Lo consume `CreateSaleAction` al crear un ORDER.
 */
@Injectable()
export class AssignTurnNumberAction {
  execute(manager: EntityManager, companyId: number): Promise<number | null> {
    return assignNextTurn(manager, companyId);
  }
}
