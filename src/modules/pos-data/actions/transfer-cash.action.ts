import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { runSerializableWithRetry } from '@/common/utils/serializable-retry';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';
import {
  AccountReference,
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { TransferCashDto } from '../dto/transfer-cash.dto';

/**
 * Datos del actor — para snapshot en `created_by` / `created_by_id` de los
 * logs y `FinancialMovement`.
 */
export interface TransferCashActor {
  id: number;
  fullName: string;
}

/**
 * Resultado de un transfer-cash. Espejo PlacePos: `{ message }`.
 */
export interface TransferCashResult {
  message: string;
}

/**
 * `POST /pos-data/transfer-cash`. Mueve efectivo desde la caja PERMANENTE
 * del actor hacia un bank o wallet.
 *
 * Diferencias respecto a `accounts/transfer`:
 *   - El origen es IMPLÍCITO (caja del actor, no parametrizable).
 *   - El destino soporta `'wallet'` y `'bank'`. `'user'` se rechaza con
 *     `422 UNSUPPORTED_DESTINATION` — el modelo cloud no tiene caja
 *     personal por usuario distinto del actor.
 *
 * Atomicidad:
 *   1. `getOrCreateCashRegisterForUser` resuelve y lockea la caja del actor.
 *   2. Lock pessimistic_write sobre el bank/wallet destino — evita oversell
 *      en lecturas concurrentes (defensa en profundidad; aquí es un INCOME,
 *      no un débito, pero preservamos la disciplina).
 *   3. Validar `register.balance >= amount`. Si falla → 422.
 *   4. UPDATE `cash_registers.balance -= amount`.
 *   5. INSERT log CASH_TRANSFER_OUT (affects_balance=true).
 *   6. UPDATE balance del destino (bank|wallet) sumando `amount`.
 *   7. INSERT `FinancialMovement` (TRANSFER) con source=cash_register,
 *      destination=bank|wallet. Lleva `reference_code` UUID v4.
 */
@Injectable()
export class TransferCashAction {
  private readonly logger = new Logger(TransferCashAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    dto: TransferCashDto,
    companyId: number,
    actor: TransferCashActor,
  ): Promise<TransferCashResult> {
    if (dto.destinationType === 'user') {
      throw new UnprocessableEntityException({
        message: 'Transferencias a caja personal de usuario no soportadas en cloud',
        payload: { code: 'UNSUPPORTED_DESTINATION' },
      });
    }
    // Narrow explícito: el guard anterior elimina 'user' del union pero
    // TypeScript no lo propaga al callback de transaction. Capturamos el
    // tipo ya estrechado en una const tipada.
    const destinationType: 'wallet' | 'bank' = dto.destinationType;

    const amountBig: Big = toBig(dto.amount);
    if (amountBig.lte(0)) {
      throw new UnprocessableEntityException('El monto debe ser mayor a cero');
    }

    // Aislamiento SERIALIZABLE (CLAUDE.md §9.4): transferencias entre la
    // caja del actor y bank/wallet combinan read+write y son susceptibles
    // a write-skew con cobros concurrentes. PG aborta con 40001 si detecta
    // anomalía; reintentamos hasta 2 veces.
    return runSerializableWithRetry<TransferCashResult>(this.dataSource, async (manager) => {
      const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
      const destination = await this.loadDestination(
        manager,
        destinationType,
        dto.destinationId,
        companyId,
      );

      const balanceBig = toBig(register.balance);
      if (balanceBig.lt(amountBig)) {
        throw new UnprocessableEntityException(
          `Saldo insuficiente en caja. Disponible: ${balanceBig.toFixed(2)}`,
        );
      }

      const amount = preciseNumber(amountBig, 2);

      // UPDATE balance origen (modelo PERMANENTE).
      const newOriginBalance = preciseNumber(balanceBig.minus(amountBig), 2);
      await manager.update(
        CashRegister,
        { id: register.id, company_id: String(companyId) },
        { balance: newOriginBalance },
      );

      await manager.getRepository(CashRegisterLog).save({
        company_id: register.company_id,
        cash_register_id: register.id,
        type: CashRegisterLogType.CASH_TRANSFER_OUT,
        direction: 'OUT',
        amount,
        affects_balance: true,
        description: `Traslado a ${destination.name}`,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      });

      const newDestBalance = preciseNumber(toBig(destination.balance).plus(amountBig), 2);
      await this.setDestinationBalance(
        manager,
        destinationType,
        destination.id,
        companyId,
        newDestBalance,
      );

      const referenceCode = `POS-TRF-${randomUUID()}`;
      const destinationAccountRef: AccountReference = destinationType;

      await this.financialMovementsService.record(manager, {
        companyId,
        amount,
        movement_type: MovementType.TRANSFER,
        concept: MovementConcept.TRANSFER,
        description: `Traslado de efectivo a ${destination.name}`,
        source_type: 'cash_register',
        source_id: Number(register.id),
        destination_type: destinationAccountRef,
        destination_id: destination.id,
        reference_code: referenceCode,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });

      this.logger.log({
        event: 'pos_data.transfer_cash_completed',
        companyId,
        actorId: actor.id,
        cashRegisterId: Number(register.id),
        amount: amountBig.toFixed(2),
        destinationType,
        destinationId: destination.id,
        referenceCode,
      });

      return { message: 'Traslado completado exitosamente' };
    });
  }

  private async loadDestination(
    manager: EntityManager,
    type: 'wallet' | 'bank',
    id: number,
    companyId: number,
  ): Promise<{ id: number; name: string; balance: number }> {
    if (type === 'wallet') {
      const wallet = await manager.findOne(Wallet, {
        where: {
          id: String(id),
          company_id: String(companyId),
          is_archived: false,
        },
        select: { id: true, name: true, balance: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new NotFoundException('Wallet destino no encontrado');
      }
      return { id: Number(wallet.id), name: wallet.name, balance: Number(wallet.balance) };
    }
    const bank = await manager.findOne(Bank, {
      where: {
        id: String(id),
        company_id: String(companyId),
        is_archived: false,
      },
      select: { id: true, name: true, balance: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!bank) {
      throw new NotFoundException('Banco destino no encontrado');
    }
    return { id: Number(bank.id), name: bank.name, balance: Number(bank.balance) };
  }

  private async setDestinationBalance(
    manager: EntityManager,
    type: 'wallet' | 'bank',
    id: number,
    companyId: number,
    newBalance: number,
  ): Promise<void> {
    if (type === 'wallet') {
      await manager.update(
        Wallet,
        { id: String(id), company_id: String(companyId) },
        { balance: newBalance },
      );
      return;
    }
    await manager.update(
      Bank,
      { id: String(id), company_id: String(companyId) },
      { balance: newBalance },
    );
  }
}
