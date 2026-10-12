import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Employee } from '../entities/employee.entity';
import { findEmployeeInCompany } from '../internal/employee-lookups';

/**
 * Concede/revoca el permiso `can_charge_orders` de un employee. Owner-only (el
 * controller hereda `@Roles('owner')`). Espejo de
 * SetEmployeeCashVisibilityAction.
 */
@Injectable()
export class SetEmployeeChargePermissionAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, canChargeOrders: boolean, companyId: number): Promise<Employee> {
    return this.dataSource.transaction<Employee>(async (manager) => {
      await findEmployeeInCompany(manager, id, companyId);

      await manager.update(
        Employee,
        { id: String(id), company_id: String(companyId) },
        { can_charge_orders: canChargeOrders },
      );

      return findEmployeeInCompany(manager, id, companyId);
    });
  }
}
