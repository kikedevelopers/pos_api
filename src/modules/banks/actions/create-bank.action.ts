import { Injectable, Logger } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';

import type { CreateBankDto } from '../dto/create-bank.dto';
import { Bank } from '../entities/bank.entity';
import { translateBankConstraintError } from '../internal/constraint-errors';

/**
 * Datos del actor que crea el bank — snapshot guardado en `created_by` y
 * `created_by_id`. Análogo a `EmployeeCreator`.
 */
export interface BankCreator {
  id: number;
  fullName: string;
}

/**
 * Crea un bank. Reglas (espejo PlacePos `banks.routes.ts`):
 *
 *   - `initial_balance > 0` → genera un `FinancialMovement`
 *     (`movement_type = INCOME`, `concept = INITIAL_BALANCE`) DENTRO de la
 *     misma transacción que el INSERT del bank.
 *
 *   - `name + account_number` duplicado dentro de la company → 409
 *     `BANK_DUPLICATE` (detectado por catch del `unique_violation` en el
 *     índice parcial).
 *
 *   - `company_id`, `created_by`, `created_by_id` se asignan desde los
 *     parámetros — NUNCA del DTO.
 *
 * Transacción: §8.8 — wrappear aun cuando sea un solo INSERT. Aquí además
 * SÍ tiene side effect: si `initial_balance > 0`, hay un segundo INSERT
 * en `financial_movements` que debe ser atómico con el primero.
 */
@Injectable()
export class CreateBankAction {
  private readonly logger = new Logger(CreateBankAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(dto: CreateBankDto, companyId: number, createdBy: BankCreator): Promise<Bank> {
    const initialBalance: Big = dto.initial_balance ? toBig(dto.initial_balance) : toBig(0);

    return this.dataSource.transaction<Bank>(async (manager) => {
      const bank = manager.create(Bank, {
        company_id: String(companyId),
        name: dto.name,
        account_number: dto.account_number,
        account_type: dto.account_type,
        balance: initialBalance.toNumber(),
        available_in_pos: dto.available_in_pos ?? false,
        is_archived: false,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });

      let saved: Bank;
      try {
        saved = await manager.save(Bank, bank);
      } catch (error) {
        translateBankConstraintError(error);
        throw error;
      }

      // Si hay saldo inicial > 0, generamos el FinancialMovement asociado.
      // Espejo de `banks.routes.ts` de PlacePos.
      if (initialBalance.gt(0)) {
        await this.financialMovementsService.record(manager, {
          companyId,
          amount: initialBalance.toNumber(),
          movement_type: MovementType.INCOME,
          concept: MovementConcept.INITIAL_BALANCE,
          description: `Saldo inicial de cuenta bancaria: ${saved.name}`,
          destination_type: 'bank',
          destination_id: Number(saved.id),
          created_by: createdBy.fullName,
          created_by_id: createdBy.id,
        });

        this.logger.log({
          event: 'bank.initial_balance_recorded',
          companyId,
          bankId: Number(saved.id),
          amount: initialBalance.toFixed(2),
        });
      }

      return saved;
    });
  }
}
