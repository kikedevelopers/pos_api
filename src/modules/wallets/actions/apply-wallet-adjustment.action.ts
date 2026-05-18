import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import {
  FinancialMovement,
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';

import type { CreateWalletAdjustmentDto } from '../dto/create-wallet-adjustment.dto';
import { Wallet } from '../entities/wallet.entity';

/**
 * Actor que aplica el adjustment.
 */
export interface WalletAdjustmentActor {
  id: number;
  fullName: string;
}

export interface WalletAdjustmentResult {
  wallet: Wallet;
  movement: FinancialMovement;
}

/**
 * `POST /wallets/:id/adjustments` — mismo flujo que
 * `ApplyBankAdjustmentAction` pero sobre `Wallet`. Lock pesimista, mismos
 * códigos de error (`ACCOUNT_NOT_FOUND` 404, `ACCOUNT_ARCHIVED` 422,
 * `INSUFFICIENT_BALANCE` 422), mismo `reference_code = uuidv4`.
 */
@Injectable()
export class ApplyWalletAdjustmentAction {
  private readonly logger = new Logger(ApplyWalletAdjustmentAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    walletId: number,
    dto: CreateWalletAdjustmentDto,
    companyId: number,
    actor: WalletAdjustmentActor,
  ): Promise<WalletAdjustmentResult> {
    const movementType: MovementType =
      dto.movement_type === 'INCOME' ? MovementType.INCOME : MovementType.EXPENSE;

    const amount: Big = toBig(dto.amount).round(2);
    const trimmedDescription = dto.description.trim();

    return this.dataSource.transaction<WalletAdjustmentResult>(async (manager) => {
      const locked = await manager
        .createQueryBuilder(Wallet, 'w')
        .setLock('pessimistic_write')
        .where('w.id = :id', { id: String(walletId) })
        .andWhere('w.company_id = :companyId', { companyId: String(companyId) })
        .getOne();

      if (!locked) {
        throw new NotFoundException('Billetera no encontrada.');
      }
      if (locked.is_archived === true) {
        throw new UnprocessableEntityException('La billetera está archivada.');
      }

      const currentBalance: Big = toBig(locked.balance);
      const signed: Big = movementType === MovementType.INCOME ? amount : amount.neg();
      const newBalance: Big = currentBalance.plus(signed).round(2);

      if (newBalance.lt(0)) {
        throw new UnprocessableEntityException(
          'El monto excede el saldo disponible de la billetera.',
        );
      }

      await manager.update(
        Wallet,
        { id: String(walletId), company_id: String(companyId) },
        { balance: newBalance.toNumber(), updated_at: new Date() },
      );

      const isIncome = movementType === MovementType.INCOME;
      const movement = await this.financialMovementsService.record(manager, {
        companyId,
        amount: amount.toNumber(),
        movement_type: movementType,
        concept: MovementConcept.ADJUSTMENT,
        description: `Corrección de caja: ${trimmedDescription}`,
        source_type: isIncome ? null : 'wallet',
        source_id: isIncome ? null : walletId,
        destination_type: isIncome ? 'wallet' : null,
        destination_id: isIncome ? walletId : null,
        reference_code: randomUUID(),
        created_by: actor.fullName,
        created_by_id: actor.id,
      });

      const updatedWallet = await manager.findOneOrFail(Wallet, {
        where: { id: String(walletId), company_id: String(companyId) },
      });

      this.logger.log({
        event: 'wallet.adjustment_applied',
        companyId,
        walletId,
        movement_type: movementType,
        amount: amount.toFixed(2),
        new_balance: newBalance.toFixed(2),
        actorId: actor.id,
      });

      return { wallet: updatedWallet, movement };
    });
  }
}
