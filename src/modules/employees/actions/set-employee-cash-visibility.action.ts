import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Employee } from '../entities/employee.entity';
import { findEmployeeInCompany } from '../internal/employee-lookups';

/**
 * Concede/revoca el permiso `can_view_cash` de un employee. Owner-only (el
 * controller hereda `@Roles('owner')`). Paridad PlacePos
 * (`PUT /employees/:id/cash-visibility`). Espejo de
 * SetEmployeeProfitVisibilityAction.
 */
@Injectable()
export class SetEmployeeCashVisibilityAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, canViewCash: boolean, companyId: number): Promise<Employee> {
    return this.dataSource.transaction<Employee>(async (manager) => {
      await findEmployeeInCompany(manager, id, companyId);

      await manager.update(
        Employee,
        { id: String(id), company_id: String(companyId) },
        { can_view_cash: canViewCash },
      );

      return findEmployeeInCompany(manager, id, companyId);
    });
  }
}
