import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';

import { Employee } from '../entities/employee.entity';
import { findEmployeeInCompany } from '../internal/employee-lookups';

/**
 * Detalle de un empleado + datos de su caja registradora (modelo PERMANENTE).
 *
 * Endpoint `GET /employees/:id`. Paridad PlacePos: el local devuelve el
 * employee + `cash_balance` y `base_amount`. Aquí mapeamos:
 *
 *   - `cash_balance` ← register.balance (0 si no tiene caja).
 *   - `base_amount`  ← register.base_amount (0 si no tiene caja).
 *
 * Read puro fuera de transacción. Si el empleado no tiene `user_id`
 * (login nunca habilitado), devolvemos 0/0 sin error — el detalle del
 * employee debe seguir siendo accesible.
 */
export interface EmployeeWithCashRegister {
  employee: Employee;
  cash_balance: number;
  base_amount: number;
}

@Injectable()
export class FindEmployeeByIdAction {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(id: number, companyId: number): Promise<EmployeeWithCashRegister> {
    const manager = this.dataSource.manager;
    const employee = await findEmployeeInCompany(manager, id, companyId);

    const employeeUserId = extractEmployeeUserId(employee);
    if (employeeUserId === null) {
      return { employee, cash_balance: 0, base_amount: 0 };
    }

    const register = await manager.findOne(CashRegister, {
      where: {
        company_id: String(companyId),
        user_id: String(employeeUserId),
      },
    });
    if (!register) {
      return { employee, cash_balance: 0, base_amount: 0 };
    }

    return {
      employee,
      cash_balance: preciseNumber(toBig(register.balance), 2),
      base_amount: preciseNumber(toBig(register.base_amount), 2),
    };
  }
}

/**
 * Lee `user_id` (mapeado como `string | null` por TypeORM) y lo convierte
 * a `number | null` para los helpers downstream.
 */
function extractEmployeeUserId(employee: Employee): number | null {
  if (employee.user_id === null || employee.user_id === undefined) {
    return null;
  }
  const parsed = Number(employee.user_id);
  return Number.isFinite(parsed) ? parsed : null;
}
