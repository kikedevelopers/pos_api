import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { Employee } from '@/modules/employees/entities/employee.entity';

/**
 * Resumen de caja del empleado (modelo PERMANENTE). Mismo shape que el
 * usado en `GET /employees/:id`. Si el employee no tiene caja (login nunca
 * habilitado o registro aún no materializado), valores en 0.
 */
export interface EmployeeCashRegisterSummary {
  cash_balance: number;
  base_amount: number;
}

/**
 * Resultado del listado: cada employee + su resumen de caja (paridad
 * PlacePos `GET /employees`).
 */
export interface EmployeeWithCashSummary {
  employee: Employee;
  cash_balance: number;
  base_amount: number;
}

/**
 * Lista employees ACTIVOS (`is_archived = false`) de una company, ordenados
 * por `created_at DESC`. Endpoint `GET /employees`.
 *
 * --------------------------------------------------------------------------
 * Paridad PlacePos: cash_balance / base_amount por employee
 * --------------------------------------------------------------------------
 *
 * El listado en PlacePos devuelve por cada employee `cash_balance` y
 * `base_amount` (campos de su `cash_register`). Para evitar N+1, hacemos UNA
 * query adicional a `cash_registers` filtrando por los `user_id`s de los
 * employees que SÍ tienen User espejo (FK no-null). Los que no, devuelven
 * 0/0.
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class FindAllEmployeesAction {
  constructor(
    @InjectRepository(Employee)
    private readonly repo: Repository<Employee>,
    @InjectRepository(CashRegister)
    private readonly cashRegisterRepo: Repository<CashRegister>,
  ) {}

  async execute(companyId: number): Promise<EmployeeWithCashSummary[]> {
    const employees = await this.repo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { created_at: 'DESC' },
    });

    // Recolecta user_ids no nulos para una sola query bulk a cash_registers.
    const userIds: string[] = employees
      .map((e) => e.user_id)
      .filter((uid): uid is string => uid !== null && uid !== undefined);

    // Mapa user_id → resumen de caja. Vacío si no hay employees con espejo.
    const registersByUserId = new Map<string, EmployeeCashRegisterSummary>();
    if (userIds.length > 0) {
      const registers = await this.cashRegisterRepo
        .createQueryBuilder('cr')
        .select(['cr.id', 'cr.user_id', 'cr.balance', 'cr.base_amount'])
        .where('cr.company_id = :companyId', { companyId: String(companyId) })
        .andWhere('cr.user_id IN (:...userIds)', { userIds })
        .getMany();

      for (const register of registers) {
        if (register.user_id === null || register.user_id === undefined) {
          continue;
        }
        registersByUserId.set(String(register.user_id), {
          cash_balance: preciseNumber(toBig(register.balance), 2),
          base_amount: preciseNumber(toBig(register.base_amount), 2),
        });
      }
    }

    return employees.map((employee) => {
      const summary = employee.user_id ? registersByUserId.get(String(employee.user_id)) : null;
      return {
        employee,
        cash_balance: summary?.cash_balance ?? 0,
        base_amount: summary?.base_amount ?? 0,
      };
    });
  }
}
