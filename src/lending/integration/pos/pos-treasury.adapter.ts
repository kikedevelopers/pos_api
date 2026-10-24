import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type {
  DisbursementInput,
  DisbursementResult,
  LendingTreasuryPort,
} from '../../ports/lending-treasury.port';
import type { LendingTx } from '../../ports/lending-tx';

/**
 * Tesorería del POS como fuente del dinero prestado.
 *
 * Saca el monto de la cuenta con lock `pessimistic_write` (dos préstamos
 * contra la misma cuenta se serializan y el segundo re-lee el saldo):
 *
 *   - 404 si la cuenta no existe en la company o está archivada.
 *   - 422 si el saldo no alcanza (no se presta plata que no hay).
 *   - Caja: la del ACTOR (resuelta aquí; el id del payload se ignora, como en
 *     gastos) + log `LOAN_DISBURSEMENT` OUT.
 *   - Banco / billetera: baja el saldo + FinancialMovement EXPENSE con
 *     concepto `LOAN_DISBURSEMENT` y el `referenceCode` del préstamo.
 *
 * Un préstamo NO es un gasto: por eso su concepto propio.
 */
@Injectable()
export class PosTreasuryAdapter implements LendingTreasuryPort {
  constructor(private readonly financialMovements: FinancialMovementsService) {}

  async disburse(tx: LendingTx, input: DisbursementInput): Promise<DisbursementResult> {
    const { companyId, sourceType, sourceId, description, referenceCode, actor } = input;
    const amountBig = toBig(input.amount);
    const amount = preciseNumber(amountBig, 2);

    if (sourceType === 'bank' || sourceType === 'wallet') {
      const isBank = sourceType === 'bank';
      const notFound = isBank ? 'Banco no encontrado' : 'Billetera no encontrada';
      if (sourceId === undefined) throw new NotFoundException(notFound);
      const entity = isBank ? Bank : Wallet;
      const account = (await tx.findOne(entity, {
        where: { id: String(sourceId), company_id: String(companyId), is_archived: false },
        lock: { mode: 'pessimistic_write' },
      })) as (Bank | Wallet) | null;
      if (!account) throw new NotFoundException(notFound);

      const balance = toBig(account.balance);
      if (amountBig.gt(balance)) {
        throw new UnprocessableEntityException(
          `Saldo insuficiente en ${isBank ? 'el banco' : 'la billetera'}. Disponible: ${balance.toFixed(2)}`,
        );
      }
      await tx.update(
        entity,
        { id: account.id, company_id: String(companyId) },
        { balance: preciseNumber(balance.minus(amountBig), 2) },
      );
      await this.financialMovements.record(tx, {
        companyId,
        amount,
        movement_type: MovementType.EXPENSE,
        concept: MovementConcept.LOAN_DISBURSEMENT,
        description,
        source_type: sourceType,
        source_id: Number(account.id),
        reference_code: referenceCode,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });
      return {
        sourceName: isBank
          ? `${(account as Bank).name} - ${(account as Bank).account_number}`
          : (account as Wallet).name,
        resolvedSourceId: Number(account.id),
      };
    }

    const register = await getOrCreateCashRegisterForUser(tx, companyId, actor.id);
    const balance = toBig(register.balance);
    if (amountBig.gt(balance)) {
      throw new UnprocessableEntityException(
        `Saldo insuficiente en la caja. Disponible: ${balance.toFixed(2)}`,
      );
    }
    await tx.update(
      CashRegister,
      { id: register.id, company_id: String(companyId) },
      { balance: preciseNumber(balance.minus(amountBig), 2) },
    );
    await tx.save(
      CashRegisterLog,
      tx.create(CashRegisterLog, {
        company_id: String(companyId),
        cash_register_id: register.id,
        type: CashRegisterLogType.LOAN_DISBURSEMENT,
        direction: 'OUT',
        amount,
        affects_balance: true,
        description,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      }),
    );
    return { sourceName: 'Caja', resolvedSourceId: Number(register.id) };
  }
}
