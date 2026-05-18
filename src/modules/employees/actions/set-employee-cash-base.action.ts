import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';

import { findEmployeeInCompany } from '../internal/employee-lookups';
import { getOrCreateEmployeeCashRegister } from '../internal/employee-cash-register-lookup';

/**
 * Resultado del endpoint `PUT /employees/:id/cash-register/base`. Espeja
 * PlacePos (`{ employee_id, base_amount }`).
 */
export interface SetEmployeeCashBaseResult {
  employee_id: number;
  base_amount: number;
}

/**
 * Fija el `base_amount` (fondo fijo) de la caja PERMANENTE del empleado.
 *
 * --------------------------------------------------------------------------
 * Reglas
 * --------------------------------------------------------------------------
 *
 *   - 400 si `base_amount < 0` (también validado en DTO).
 *   - 422 `EMPLOYEE_HAS_NO_CASH_REGISTER` si el empleado NO tiene
 *     `login_enabled` (la caja solo existe para empleados con login).
 *     Lanzado por `getOrCreateEmployeeCashRegister`.
 *   - Si `login_enabled=true` pero `user_id=null`, el helper materializa el
 *     User espejo on-the-fly.
 *
 * Sin movimiento financiero — es solo configuración del fondo fijo.
 *
 * --------------------------------------------------------------------------
 * Transacción
 * --------------------------------------------------------------------------
 *
 * Envolvemos el flujo en `dataSource.transaction` (CLAUDE.md §8.8) +
 * `getOrCreateCashRegisterForUser` ya aplica lock pessimistic_write para
 * evitar carreras con cobros/pagos concurrentes.
 */
@Injectable()
export class SetEmployeeCashBaseAction {
  private readonly logger = new Logger(SetEmployeeCashBaseAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    id: number,
    baseAmount: number,
    companyId: number,
  ): Promise<SetEmployeeCashBaseResult> {
    const baseBig = toBig(baseAmount);
    if (baseBig.lt(0)) {
      throw new BadRequestException('base_amount no puede ser negativo');
    }
    const persistedBase = preciseNumber(baseBig, 2);

    return this.dataSource.transaction<SetEmployeeCashBaseResult>(async (manager) => {
      const employee = await findEmployeeInCompany(manager, id, companyId);

      // El helper levanta 422 EMPLOYEE_HAS_NO_CASH_REGISTER si el employee
      // no puede operar caja (login_enabled=false). Si login_enabled=true
      // pero user_id=null, el helper materializa el User espejo.
      const register = await getOrCreateEmployeeCashRegister(manager, employee, companyId);

      await manager.update(
        CashRegister,
        { id: register.id, company_id: String(companyId) },
        { base_amount: persistedBase },
      );

      this.logger.log({
        event: 'employee.cash_base_set',
        companyId,
        employeeId: Number(employee.id),
        cashRegisterId: Number(register.id),
        baseAmount: persistedBase,
      });

      return {
        employee_id: Number(employee.id),
        base_amount: persistedBase,
      };
    });
  }
}
