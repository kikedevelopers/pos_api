import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import {
  FinancialMovement,
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';

import type { CreateBankAdjustmentDto } from '../dto/create-bank-adjustment.dto';
import { Bank } from '../entities/bank.entity';

/**
 * Actor que aplica el adjustment (snapshot para `created_by` / `created_by_id`).
 */
export interface BankAdjustmentActor {
  id: number;
  fullName: string;
}

/**
 * Resultado de aplicar un adjustment manual.
 */
export interface BankAdjustmentResult {
  bank: Bank;
  movement: FinancialMovement;
}

/**
 * `POST /banks/:id/adjustments` — espejo de `applyManualAdjustment` de PlacePos.
 *
 *   1. Transacción atómica.
 *   2. Lock pesimista del Bank (`setLock('pessimistic_write')`) dentro de la
 *      misma company. Bloquea concurrencias sobre el mismo balance.
 *   3. 404 (`ACCOUNT_NOT_FOUND`) si el banco no existe en la company —
 *      mensaje genérico anti-enumeración cross-tenant.
 *   4. 422 (`ACCOUNT_ARCHIVED`) si `is_archived`.
 *   5. Calcula el nuevo balance con Big.js (`plus`/`minus`, round(2)).
 *   6. 422 (`INSUFFICIENT_BALANCE`) si `EXPENSE` y el nuevo balance < 0.
 *   7. UPDATE balance + INSERT FinancialMovement con `concept = ADJUSTMENT`,
 *      `description = 'Corrección de caja: {trim(desc)}'`,
 *      `reference_code = uuidv4()`. Source o destination según movement_type.
 *
 * Roles: el controller exige `owner|superadmin`. Aquí no re-validamos roles.
 */
@Injectable()
export class ApplyBankAdjustmentAction {
  private readonly logger = new Logger(ApplyBankAdjustmentAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    bankId: number,
    dto: CreateBankAdjustmentDto,
    companyId: number,
    actor: BankAdjustmentActor,
  ): Promise<BankAdjustmentResult> {
    const movementType: MovementType =
      dto.movement_type === 'INCOME' ? MovementType.INCOME : MovementType.EXPENSE;

    // Big.js para preservar precisión monetaria; se redondea a 2 al persistir.
    const amount: Big = toBig(dto.amount).round(2);
    const trimmedDescription = dto.description.trim();

    return this.dataSource.transaction<BankAdjustmentResult>(async (manager) => {
      // Lock pesimista en la fila del bank dentro de la company.
      // Importante: el filtro `company_id` se aplica DENTRO del lock para
      // no exponer la existencia de bancos de otras companies.
      const locked = await manager
        .createQueryBuilder(Bank, 'b')
        .setLock('pessimistic_write')
        .where('b.id = :id', { id: String(bankId) })
        .andWhere('b.company_id = :companyId', { companyId: String(companyId) })
        .getOne();

      if (!locked) {
        throw new NotFoundException('Cuenta bancaria no encontrada.');
      }
      if (locked.is_archived === true) {
        throw new UnprocessableEntityException('La cuenta bancaria está archivada.');
      }

      const currentBalance: Big = toBig(locked.balance);
      const signed: Big = movementType === MovementType.INCOME ? amount : amount.neg();
      const newBalance: Big = currentBalance.plus(signed).round(2);

      if (newBalance.lt(0)) {
        throw new UnprocessableEntityException('El monto excede el saldo disponible del banco.');
      }

      await manager.update(
        Bank,
        { id: String(bankId), company_id: String(companyId) },
        { balance: newBalance.toNumber(), updated_at: new Date() },
      );

      const isIncome = movementType === MovementType.INCOME;
      const movement = await this.financialMovementsService.record(manager, {
        companyId,
        amount: amount.toNumber(),
        movement_type: movementType,
        concept: MovementConcept.ADJUSTMENT,
        description: `Corrección de caja: ${trimmedDescription}`,
        source_type: isIncome ? null : 'bank',
        source_id: isIncome ? null : bankId,
        destination_type: isIncome ? 'bank' : null,
        destination_id: isIncome ? bankId : null,
        reference_code: randomUUID(),
        created_by: actor.fullName,
        created_by_id: actor.id,
      });

      // Re-fetch del bank actualizado para devolver el estado fresco
      // (balance, updated_at). findOneOrFail porque el UPDATE confirmó
      // la existencia.
      const updatedBank = await manager.findOneOrFail(Bank, {
        where: { id: String(bankId), company_id: String(companyId) },
      });

      this.logger.log({
        event: 'bank.adjustment_applied',
        companyId,
        bankId,
        movement_type: movementType,
        amount: amount.toFixed(2),
        new_balance: newBalance.toFixed(2),
        actorId: actor.id,
      });

      return { bank: updatedBank, movement };
    });
  }
}
