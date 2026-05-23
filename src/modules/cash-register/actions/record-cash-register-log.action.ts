import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

import { CashRegister } from '../entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogDirection,
  CashRegisterLogType,
} from '../entities/cash-register-log.entity';
import { getOrCreateCashRegisterForUser } from '../internal/get-or-create-cash-register-for-user.helper';

/**
 * Input para registrar un log en `cash_register_logs`. El caller especifica:
 *
 *   - `companyId`: tenant del flujo.
 *   - **uno de** (`cashRegisterId` xor `userId`): si conoce la caja exacta,
 *     pasa `cashRegisterId` (típico cuando ya la resolvió antes); si solo
 *     conoce al actor/destinatario, pasa `userId` y la action resuelve (o
 *     crea) su caja con `getOrCreateCashRegisterForUser`.
 *   - `type`, `direction`, `amount`, `affects_balance`, `description`: campos
 *     directos del log.
 *   - `created_by`, `created_by_id`: snapshot del actor que dispara el log
 *     (NO necesariamente el dueño de la caja: en una transferencia bank→user,
 *     el actor es el owner y la caja es la del destinatario).
 *
 * `is_credit_related`, `invoice_id`, `payment_id`, `credit_note_id` son
 * opcionales — el flujo origen los completa si la operación los enlaza.
 */
export interface RecordCashRegisterLogInput {
  companyId: number;
  cashRegisterId?: number;
  userId?: number;
  type: CashRegisterLogType;
  direction: CashRegisterLogDirection;
  amount: number | string;
  affects_balance: boolean;
  description?: string | null;
  created_by?: string | null;
  created_by_id?: number | null;
  invoice_id?: number | null;
  payment_id?: number | null;
  credit_note_id?: number | null;
  is_credit_related?: boolean;
}

/**
 * Resultado: la caja resuelta + el log insertado. El caller suele necesitar
 * el `cashRegisterId` para chain operaciones (p. ej. devolver el balance
 * actualizado al frontend).
 */
export interface RecordCashRegisterLogResult {
  cashRegisterId: number;
  log: CashRegisterLog;
}

/**
 * Inserta un row en `cash_register_logs` DENTRO de la transacción del caller.
 * Si `affects_balance=true`, también ajusta `cash_registers.balance` en la
 * misma transacción (UPDATE con lock pessimistic_write ya adquirido vía
 * `getOrCreateCashRegisterForUser`).
 *
 * --------------------------------------------------------------------------
 * Diseño
 * --------------------------------------------------------------------------
 *
 * - Inyectable: otros módulos (accounts, expenses, sales, etc.) lo importan
 *   vía `CashRegisterModule.exports` y lo llaman dentro de su propia
 *   `dataSource.transaction(...)`.
 * - NUNCA abre transacción propia — el caller la abre.
 * - SIEMPRE valida que la caja referenciada (o resuelta vía userId)
 *   pertenezca a `companyId` — defensa en profundidad contra IDOR.
 * - Cuando `affects_balance=true`, recalcula el nuevo balance con Big.js:
 *
 *       newBalance = current ± amount   (signo según direction)
 *
 *   PlacePos NO permite balance negativo en la caja; el chk constraint
 *   `chk_cash_registers_balance_non_negative` rechazará el UPDATE si la
 *   resta llevaría a < 0. Es responsabilidad del caller validar saldo
 *   suficiente ANTES.
 */
@Injectable()
export class RecordCashRegisterLogAction {
  async execute(
    manager: EntityManager,
    input: RecordCashRegisterLogInput,
  ): Promise<RecordCashRegisterLogResult> {
    const register = await this.resolveRegister(manager, input);

    const amountBig = toBig(input.amount);
    if (amountBig.lt(0)) {
      throw new InternalServerErrorException(
        'record-cash-register-log: amount no puede ser negativo',
      );
    }
    const amount = preciseNumber(amountBig, 2);

    if (input.affects_balance) {
      const balanceBig = toBig(register.balance);
      const delta = input.direction === 'IN' ? amountBig : amountBig.neg();
      const newBalance = preciseNumber(balanceBig.plus(delta), 2);

      await manager.update(
        CashRegister,
        { id: register.id, company_id: String(input.companyId) },
        { balance: newBalance },
      );
    }

    const log = manager.create(CashRegisterLog, {
      company_id: String(input.companyId),
      cash_register_id: register.id,
      type: input.type,
      direction: input.direction,
      amount,
      affects_balance: input.affects_balance,
      description: input.description ?? null,
      created_by: input.created_by ?? null,
      created_by_id:
        input.created_by_id !== null && input.created_by_id !== undefined
          ? String(input.created_by_id)
          : null,
      invoice_id:
        input.invoice_id !== null && input.invoice_id !== undefined
          ? String(input.invoice_id)
          : null,
      payment_id:
        input.payment_id !== null && input.payment_id !== undefined
          ? String(input.payment_id)
          : null,
      credit_note_id:
        input.credit_note_id !== null && input.credit_note_id !== undefined
          ? String(input.credit_note_id)
          : null,
      is_credit_related: input.is_credit_related ?? false,
    });
    const saved = await manager.save(CashRegisterLog, log);

    return {
      cashRegisterId: Number(register.id),
      log: saved,
    };
  }

  /**
   * Devuelve la caja a usar, lockeada con `pessimistic_write`. Acepta:
   *
   *   - `cashRegisterId` explícito → verifica que pertenezca a `companyId`.
   *   - `userId` → resuelve/crea la caja del usuario en esa company.
   *
   * Si el caller pasa ambos, prevalece `cashRegisterId` (es el más
   * específico). Si no pasa ninguno, es un bug del caller.
   */
  private async resolveRegister(
    manager: EntityManager,
    input: RecordCashRegisterLogInput,
  ): Promise<CashRegister> {
    if (input.cashRegisterId !== undefined) {
      const found = await manager.findOne(CashRegister, {
        where: {
          id: String(input.cashRegisterId),
          company_id: String(input.companyId),
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!found) {
        throw new InternalServerErrorException(
          `record-cash-register-log: cash_register#${input.cashRegisterId} no pertenece a company ${input.companyId}`,
        );
      }
      return found;
    }
    if (input.userId !== undefined) {
      return getOrCreateCashRegisterForUser(manager, input.companyId, input.userId);
    }
    throw new InternalServerErrorException(
      'record-cash-register-log: debe especificarse cashRegisterId o userId',
    );
  }
}
