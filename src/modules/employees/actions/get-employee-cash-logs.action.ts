import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { CashRegisterService } from '@/modules/cash-register/cash-register.service';
import type { CashRegisterLog } from '@/modules/cash-register/entities/cash-register-log.entity';

import { findEmployeeInCompany } from '../internal/employee-lookups';

/**
 * Historial de caja de un employee ARBITRARIO (el detalle del admin), no el del
 * actor. Resuelve el `user_id` espejo del empleado y reusa
 * `CashRegisterService.listLogs`. Si el empleado no tiene login/caja → [].
 * Owner-only (el controller hereda `@Roles('owner')`). Paridad PlacePos
 * (`GET /employees/:id/cash-register/logs`).
 */
@Injectable()
export class GetEmployeeCashLogsAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cashRegisterService: CashRegisterService,
  ) {}

  async execute(id: number, companyId: number, limit: number): Promise<CashRegisterLog[]> {
    const employee = await findEmployeeInCompany(this.dataSource.manager, id, companyId);
    const userId = employee.user_id !== null ? Number(employee.user_id) : null;
    if (userId === null) return [];
    return this.cashRegisterService.listLogs(companyId, userId, limit);
  }
}
