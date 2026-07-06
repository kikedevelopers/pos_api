import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Employee } from '../entities/employee.entity';
import { findEmployeeInCompany } from '../internal/employee-lookups';

/**
 * Patch parcial de los permisos de visibilidad de márgenes/ganancias. El toggle
 * principal manda los tres (cascada); un subtoggle manda solo el suyo.
 */
export interface ProfitVisibilityPatch {
  can_view_profit?: boolean;
  can_view_product_margin?: boolean;
  can_view_product_profit?: boolean;
}

const FIELDS: Array<keyof ProfitVisibilityPatch> = [
  'can_view_profit',
  'can_view_product_margin',
  'can_view_product_profit',
];

/**
 * Concede/revoca `can_view_profit` y sus subpermisos del configurador de
 * producto (`can_view_product_margin` / `can_view_product_profit`) de un
 * employee. Owner-only (el controller hereda `@Roles('owner')`). Paridad PlacePos
 * (`PUT /employees/:id/profit-visibility`).
 *
 * Defensa en profundidad: `manager.update({ id, company_id }, patch)` mantiene
 * el filtro multi-tenant en el WHERE. La verificación de existencia + UPDATE +
 * re-fetch comparten transacción (snapshot isolation), como UpdateEmployeeAction.
 */
@Injectable()
export class SetEmployeeProfitVisibilityAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, input: ProfitVisibilityPatch, companyId: number): Promise<Employee> {
    // Solo los campos booleanos presentes forman el patch (ignora undefined).
    const patch: ProfitVisibilityPatch = {};
    for (const field of FIELDS) {
      if (typeof input[field] === 'boolean') patch[field] = input[field];
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('No se recibió ningún permiso para actualizar');
    }

    return this.dataSource.transaction<Employee>(async (manager) => {
      // Pre-validar existencia + tenancy (404 anti-enumeración si es ajeno).
      await findEmployeeInCompany(manager, id, companyId);

      await manager.update(Employee, { id: String(id), company_id: String(companyId) }, patch);

      return findEmployeeInCompany(manager, id, companyId);
    });
  }
}
