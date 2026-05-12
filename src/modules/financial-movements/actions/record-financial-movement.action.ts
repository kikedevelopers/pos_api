import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

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
 *
 * **Defense in depth (CRIT-2 auditoría)**: si `source_type` o
 * `destination_type` referencian `bank`/`wallet`, validamos que el id
 * pertenezca a la misma `companyId`. Los callers actuales (TransferAction,
 * CreateBankAction, CreateWalletAction) ya hacen esa validación antes,
 * pero replicarla aquí protege contra futuros callers que olviden el
 * filtro multi-tenant.
 */
@Injectable()
export class RecordFinancialMovementAction {
  async execute(
    manager: EntityManager,
    input: RecordFinancialMovementInput,
  ): Promise<FinancialMovement> {
    await this.assertAccountInCompany(
      manager,
      input.source_type,
      input.source_id,
      input.companyId,
      'source',
    );
    await this.assertAccountInCompany(
      manager,
      input.destination_type,
      input.destination_id,
      input.companyId,
      'destination',
    );

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

  /**
   * Verifica que un id de bank/wallet pertenezca a la company. Solo aplica a
   * tipos `'bank'` y `'wallet'`; `'external'` u otros tipos no son
   * verificables a nivel de DB y se permiten sin checks (ya que representan
   * partes no controladas por nuestro sistema).
   *
   * Lanza `InternalServerErrorException` si el id no corresponde a la
   * company — esto es síntoma de un bug del caller, no input de usuario:
   * el flujo HTTP normal ya valida ownership antes de invocar `record`.
   */
  private async assertAccountInCompany(
    manager: EntityManager,
    type: AccountReference | null | undefined,
    id: number | null | undefined,
    companyId: number,
    role: 'source' | 'destination',
  ): Promise<void> {
    if (id === null || id === undefined) {
      return;
    }
    if (type !== 'bank' && type !== 'wallet') {
      // 'external' / null / cualquier otro tipo no se verifica.
      return;
    }

    const entity = type === 'bank' ? Bank : Wallet;
    const found = await manager.findOne(entity, {
      where: { id: String(id), company_id: String(companyId) },
      select: { id: true },
    });
    if (!found) {
      throw new InternalServerErrorException(
        `record-financial-movement: ${role} ${type}#${id} no pertenece a company ${companyId}`,
      );
    }
  }
}
