import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Role } from '@/modules/roles/entities/role.entity';

/**
 * Verifica que un `role_id` pertenezca a la company del actor antes de
 * asignarlo a un empleado. Lanza `BadRequestException` (400) si el rol no
 * existe o es de otra company — blindaje multi-tenant: el owner nunca asigna a
 * sus empleados un rol ajeno.
 *
 * Se ejecuta DENTRO de la transacción de create/update (recibe el `manager`)
 * para que la verificación y el INSERT/UPDATE compartan snapshot.
 */
export async function assertRoleBelongsToCompany(
  manager: EntityManager,
  roleId: number,
  companyId: number,
): Promise<void> {
  const role = await manager.findOne(Role, {
    where: { id: String(roleId), company_id: String(companyId) },
  });
  if (!role) {
    throw new BadRequestException('El rol indicado no pertenece a la empresa');
  }
}
