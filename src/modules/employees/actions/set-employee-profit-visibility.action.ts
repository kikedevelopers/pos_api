import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Employee } from '../entities/employee.entity';
import { findEmployeeInCompany } from '../internal/employee-lookups';

/**
 * Concede/revoca el permiso `can_view_profit` de un employee. Owner-only (el
 * controller hereda `@Roles('owner')`). Paridad PlacePos
 * (`PUT /employees/:id/profit-visibility`).
 *
 * Defensa en profundidad: `manager.update({ id, company_id }, patch)` mantiene
 * el filtro multi-tenant en el WHERE. La verificación de existencia + UPDATE +
 * re-fetch comparten transacción (snapshot isolation), como UpdateEmployeeAction.
 */
@Injectable()
export class SetEmployeeProfitVisibilityAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, canViewProfit: boolean, companyId: number): Promise<Employee> {
    return this.dataSource.transaction<Employee>(async (manager) => {
      // Pre-validar existencia + tenancy (404 anti-enumeración si es ajeno).
      await findEmployeeInCompany(manager, id, companyId);

      await manager.update(
        Employee,
        { id: String(id), company_id: String(companyId) },
        { can_view_profit: canViewProfit },
      );

      return findEmployeeInCompany(manager, id, companyId);
    });
  }
}
