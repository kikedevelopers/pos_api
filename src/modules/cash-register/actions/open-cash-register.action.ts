import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import type { AccountKind } from '@/common/types/jwt-payload.type';

import type { OpenCashRegisterDto } from '../dto/open-cash-register.dto';
import { CashRegister, CashRegisterStatus } from '../entities/cash-register.entity';
import { translateCashRegisterConstraintError } from '../internal/constraint-errors';

/**
 * Quién abre el turno. Espejo de `EmployeeCreator`/`BankCreator`.
 *
 * `account` discrimina entre User (owner) y Employee — el snapshot del
 * abridor se guarda en la columna correspondiente (XOR enforced en DB).
 */
export interface CashRegisterOpener {
  id: number;
  fullName: string;
  account: AccountKind;
}

/**
 * Abre un turno de caja para la company autenticada.
 *
 *   - Si ya hay un turno abierto, lanza 409 con `code:
 *     CASH_REGISTER_ALREADY_OPEN`. La detección viene del UNIQUE parcial
 *     `(company_id) WHERE status = 'open'` — defensa dura contra race
 *     conditions de doble apertura.
 *
 *   - `opening_balance` opcional (default 0). Es el cash físico contado
 *     por el cajero al abrir.
 *
 *   - El opener se guarda en `opened_by_user_id` O `opened_by_employee_id`
 *     según `account`. CHECK XOR asegura exactamente uno.
 *
 * Transacción: §8.8 — wrappear aun cuando sea un solo INSERT. Si en el
 * futuro abrir caja conlleva side effects (audit log persistido, etc.),
 * hereda atomicidad sin revisión.
 */
@Injectable()
export class OpenCashRegisterAction {
  private readonly logger = new Logger(OpenCashRegisterAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: OpenCashRegisterDto,
    companyId: number,
    opener: CashRegisterOpener,
  ): Promise<CashRegister> {
    const openingBalance = dto.opening_balance ? toBig(dto.opening_balance) : toBig(0);

    const saved = await this.dataSource.transaction<CashRegister>(async (manager) => {
      const register = manager.create(CashRegister, {
        company_id: String(companyId),
        opened_by_user_id: opener.account === 'user' ? String(opener.id) : null,
        opened_by_employee_id: opener.account === 'employee' ? String(opener.id) : null,
        opened_by_name: opener.fullName,
        opening_balance: openingBalance.toNumber(),
        status: CashRegisterStatus.OPEN,
      });

      try {
        return await manager.save(CashRegister, register);
      } catch (error) {
        translateCashRegisterConstraintError(error);
        throw error;
      }
    });

    this.logger.log({
      event: 'cash_register.opened',
      companyId,
      cashRegisterId: Number(saved.id),
      openedBy: opener.id,
      openedByAccount: opener.account,
      openingBalance: openingBalance.toFixed(2),
    });

    return saved;
  }
}
