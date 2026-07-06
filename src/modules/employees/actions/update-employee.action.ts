import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateEmployeeDto } from '../dto/update-employee.dto';
import { Employee } from '../entities/employee.entity';
import { findEmployeeInCompany } from '../internal/employee-lookups';
import { resolveCashVisibilityOnRoleChange } from '../internal/cash-visibility';
import { assertRoleBelongsToCompany } from '../internal/role-validation';
import { findRoleIdByName } from '@/modules/roles/internal/system-roles';

/**
 * Actualiza campos de perfil (name/phone/email/address/role). NO toca
 * credenciales ni archived (esos van en endpoints específicos).
 *
 * Defensa en profundidad: usamos `manager.update({ id, company_id }, dto)` en
 * vez de `findOne + save` para que el filtro multi-tenant esté en el WHERE del
 * UPDATE. Si por algún bug el id de otra company se colara, la query
 * actualizaría 0 filas y el `findEmployeeInCompany` posterior tiraría 404.
 *
 * Transacción: §8.8 del CLAUDE.md — la verificación de existencia + el UPDATE
 * + el re-fetch comparten el mismo manager (snapshot isolation). Sin la
 * transacción, una eliminación concurrente entre los pasos generaría un 404
 * con UPDATE de 0 filas (inconsistencia de UX, aunque no de seguridad).
 */
@Injectable()
export class UpdateEmployeeAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, dto: UpdateEmployeeDto, companyId: number): Promise<Employee> {
    return this.dataSource.transaction<Employee>(async (manager) => {
      // Pre-validar existencia + tenancy. Sin esto, un update con `dto = {}`
      // sobre un id ajeno respondería 200 con datos correctos pero sin haber
      // tocado nada — UX confusa.
      const existing = await findEmployeeInCompany(manager, id, companyId);

      // Construimos el patch solo con campos definidos para no nullificar
      // accidentalmente columnas no enviadas.
      const patch: Partial<Employee> = {};
      if (dto.name !== undefined) {
        patch.name = dto.name;
      }
      if (dto.phone !== undefined) {
        patch.phone = dto.phone ?? null;
      }
      if (dto.email !== undefined) {
        patch.email = dto.email ?? null;
      }
      if (dto.address !== undefined) {
        patch.address = dto.address ?? null;
      }
      if (dto.role !== undefined) {
        patch.role = dto.role;
      }
      // FASE 2 (ROLES): asignar/limpiar el rol personalizado. Si viene un
      // role_id no-null, validar pertenencia a la company (multi-tenant). `null`
      // desasigna el rol (cae a permisos legacy).
      if (dto.role_id !== undefined) {
        if (dto.role_id !== null) {
          await assertRoleBelongsToCompany(manager, dto.role_id, companyId);
        }
        const newRoleId = dto.role_id != null ? String(dto.role_id) : null;
        patch.role_id = newRoleId;

        // Al cambiar el rol a "Cajero" (transición) se activa "ver caja" por
        // defecto. Si el rol no cambia a Cajero, no se toca (respeta el OFF
        // explícito del admin). Paridad PlacePos.
        const cajeroRoleId = await findRoleIdByName(manager, companyId, 'Cajero');
        const cashDefault = resolveCashVisibilityOnRoleChange(
          newRoleId,
          existing.role_id ?? null,
          cajeroRoleId,
        );
        if (cashDefault !== undefined) {
          patch.can_view_cash = cashDefault;
        }
      }

      if (Object.keys(patch).length === 0) {
        // Body vacío: devolvemos el row tal cual. Mismo comportamiento que
        // PlacePos (el cliente puede mandar PUT con `{}` para refrescar).
        return existing;
      }

      await manager.update(Employee, { id: String(id), company_id: String(companyId) }, patch);
      return findEmployeeInCompany(manager, id, companyId);
    });
  }
}
