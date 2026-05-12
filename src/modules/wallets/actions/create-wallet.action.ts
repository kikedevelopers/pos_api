import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';

import type { CreateWalletDto } from '../dto/create-wallet.dto';
import { Wallet } from '../entities/wallet.entity';
import { translateWalletConstraintError } from '../internal/constraint-errors';

/**
 * Datos del actor que crea la wallet (snapshot en created_by/created_by_id).
 */
export interface WalletCreator {
  id: number;
  fullName: string;
}

/**
 * Crea una wallet. Reglas (espejo PlacePos):
 *
 *   - `name` duplicado dentro de la company (entre activas) → 400 con
 *     mensaje EXACTO de PlacePos: "Ya existe una billetera con el mismo
 *     nombre". Status 400 (no 409) por paridad estricta — el frontend
 *     puede branchear por status.
 *
 *   - `initial_balance > 0` → `FinancialMovement` (INITIAL_BALANCE) en la
 *     misma transacción.
 *
 *   - `company_id`, `created_by`, `created_by_id` se asignan desde
 *     parámetros — nunca del DTO.
 */
@Injectable()
export class CreateWalletAction {
  private readonly logger = new Logger(CreateWalletAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    dto: CreateWalletDto,
    companyId: number,
    createdBy: WalletCreator,
  ): Promise<Wallet> {
    const initialBalance: Big = dto.initial_balance ? toBig(dto.initial_balance) : toBig(0);

    return this.dataSource.transaction<Wallet>(async (manager) => {
      // Fast-path duplicado: read previo para responder 400 amigable sin
      // depender solo del race-path. El index parcial lo cubre como hard-path.
      const existing = await manager.findOne(Wallet, {
        where: { company_id: String(companyId), name: dto.name, is_archived: false },
        select: { id: true },
      });
      if (existing) {
        throw new BadRequestException('Ya existe una billetera con el mismo nombre');
      }

      const wallet = manager.create(Wallet, {
        company_id: String(companyId),
        name: dto.name,
        balance: initialBalance.toNumber(),
        is_archived: false,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });

      let saved: Wallet;
      try {
        saved = await manager.save(Wallet, wallet);
      } catch (error) {
        translateWalletConstraintError(error);
        throw error;
      }

      if (initialBalance.gt(0)) {
        await this.financialMovementsService.record(manager, {
          companyId,
          amount: initialBalance.toNumber(),
          movement_type: MovementType.INCOME,
          concept: MovementConcept.INITIAL_BALANCE,
          description: `Saldo inicial de billetera: ${saved.name}`,
          destination_type: 'wallet',
          destination_id: Number(saved.id),
          created_by: createdBy.fullName,
          created_by_id: createdBy.id,
        });

        this.logger.log({
          event: 'wallet.initial_balance_recorded',
          companyId,
          walletId: Number(saved.id),
          amount: initialBalance.toFixed(2),
        });
      }

      return saved;
    });
  }
}
