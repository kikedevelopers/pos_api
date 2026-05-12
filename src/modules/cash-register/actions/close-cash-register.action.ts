import { Injectable, Logger } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

import type { CloseCashRegisterDto } from '../dto/close-cash-register.dto';
import { CashRegisterLog, CashRegisterLogDirection } from '../entities/cash-register-log.entity';
import { CashRegister, CashRegisterStatus } from '../entities/cash-register.entity';
import { requireOpenCashRegister } from '../internal/cash-register-lookups';

/**
 * Cierra el turno actualmente abierto.
 *
 * Lógica:
 *
 *   1. Carga el turno abierto. Si no hay → 404.
 *   2. Carga TODOS los logs con `affects_balance = true` del turno.
 *   3. Calcula:
 *        expected_balance = opening_balance
 *                         + Σ amount WHERE direction = 'IN'
 *                         - Σ amount WHERE direction = 'OUT'
 *        difference = closing_balance - expected_balance
 *      Cálculo con Big.js (no `number`). Resultado redondeado a 2 decimales.
 *   4. UPDATE atómico del turno con `status = 'closed'` y los campos
 *      derivados.
 *
 * `difference != 0` NO bloquea el cierre — el turno queda registrado con
 * la diferencia y el cliente puede mostrar alerta de descuadre.
 *
 * Transacción: el read del turno + read de logs + cálculo + UPDATE viven
 * en el mismo manager (snapshot isolation). Sin transacción, un log
 * concurrente entre el SELECT y el UPDATE podría dejar el expected
 * stale.
 */
@Injectable()
export class CloseCashRegisterAction {
  private readonly logger = new Logger(CloseCashRegisterAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CloseCashRegisterDto,
    companyId: number,
    actorId: number,
  ): Promise<CashRegister> {
    const closingBalance = toBig(dto.closing_balance);

    return this.dataSource.transaction<CashRegister>(async (manager) => {
      const register = await requireOpenCashRegister(manager, companyId);

      const logs = await manager.find(CashRegisterLog, {
        where: {
          cash_register_id: register.id,
          company_id: String(companyId),
          affects_balance: true,
        },
      });

      let expected: Big = toBig(register.opening_balance);
      for (const log of logs) {
        const amount = toBig(log.amount);
        const direction: CashRegisterLogDirection = log.direction;
        if (direction === 'IN') {
          expected = expected.plus(amount);
        } else {
          expected = expected.minus(amount);
        }
      }
      const difference = closingBalance.minus(expected);

      await manager.update(
        CashRegister,
        { id: register.id, company_id: String(companyId) },
        {
          status: CashRegisterStatus.CLOSED,
          closing_balance: preciseNumber(closingBalance, 2),
          expected_balance: preciseNumber(expected, 2),
          difference: preciseNumber(difference, 2),
          closed_at: new Date(),
        },
      );

      this.logger.log({
        event: 'cash_register.closed',
        companyId,
        cashRegisterId: Number(register.id),
        actorId,
        opening: register.opening_balance,
        closing: preciseNumber(closingBalance, 2),
        expected: preciseNumber(expected, 2),
        difference: preciseNumber(difference, 2),
      });

      const refreshed = await manager.findOne(CashRegister, {
        where: { id: register.id, company_id: String(companyId) },
      });
      if (!refreshed) {
        throw new Error('Caja desapareció dentro de la transacción de cierre');
      }
      return refreshed;
    });
  }
}
