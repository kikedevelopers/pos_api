import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import {
  AccountReference,
  FinancialMovement,
  MovementConcept,
  MovementType,
} from '../entities/financial-movement.entity';

/**
 * Datos requeridos para registrar un movimiento financiero. Se exige un
 * `manager` (EntityManager transaccional) porque el movimiento DEBE
 * formar parte de la misma transacción que el cambio de balance que lo
 * origina (venta, transferencia, ingreso inicial...).
 */
export interface RecordFinancialMovementInput {
  companyId: number;
  amount: string | number;
  movement_type: MovementType;
  concept: MovementConcept;
  description?: string | null;
  source_type?: AccountReference | null;
  source_id?: number | null;
  destination_type?: AccountReference | null;
  destination_id?: number | null;
  reference_code?: string | null;
  created_by?: string | null;
  created_by_id?: number | null;
}

/**
 * Crea un `FinancialMovement` dentro de una transacción dada por el caller.
 *
 * Razón del diseño:
 *   - El módulo `financial-movements` NO expone POST público — los rows se
 *     generan EXCLUSIVAMENTE como side effect de otras operaciones
 *     (banks.create con saldo inicial, accounts.transfer, ventas, etc.).
 *   - Se expone como Action para que otros módulos lo inyecten y lo
 *     invoquen dentro de SU propia transacción, garantizando atomicidad.
 *
 * El service interno no abre transacción propia — espera recibir el
 * `manager` del callback `dataSource.transaction(...)` del caller.
 */
@Injectable()
export class RecordFinancialMovementAction {
  async execute(
    manager: EntityManager,
    input: RecordFinancialMovementInput,
  ): Promise<FinancialMovement> {
    const repo = manager.getRepository(FinancialMovement);

    const movement = repo.create({
      company_id: String(input.companyId),
      amount: typeof input.amount === 'number' ? input.amount : Number(input.amount),
      movement_type: input.movement_type,
      concept: input.concept,
      description: input.description ?? null,
      source_type: input.source_type ?? null,
      source_id:
        input.source_id !== null && input.source_id !== undefined ? String(input.source_id) : null,
      destination_type: input.destination_type ?? null,
      destination_id:
        input.destination_id !== null && input.destination_id !== undefined
          ? String(input.destination_id)
          : null,
      reference_code: input.reference_code ?? null,
      created_by: input.created_by ?? null,
      created_by_id:
        input.created_by_id !== null && input.created_by_id !== undefined
          ? String(input.created_by_id)
          : null,
    });

    return repo.save(movement);
  }
}
