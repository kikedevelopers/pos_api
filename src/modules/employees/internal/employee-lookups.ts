import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Employee } from '@/modules/employees/entities/employee.entity';

/**
 * Lookup por id dentro de una company usando un `EntityManager` (transaccional
 * o no). Lanza `NotFoundException` si no existe O pertenece a otra company.
 * No se distingue entre los dos casos — anti-enumeración.
 *
 * NO filtra `is_archived`: las actions de update/credentials/toggle operan
 * sobre activos y archivados; el listado público sí filtra.
 *
 * Se expone como helper interno para que las actions de mutación puedan
 * reutilizar la lectura DENTRO de la misma transacción que el subsiguiente
 * UPDATE (snapshot isolation). Si se delegara a otra action vía DI, el read
 * usaría un repo distinto al manager transaccional y se perdería la garantía.
 */
export async function findEmployeeInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
): Promise<Employee> {
  const employee = await manager.findOne(Employee, {
    where: { id: String(id), company_id: String(companyId) },
  });
  if (!employee) {
    throw new NotFoundException('Empleado no encontrado');
  }
  return employee;
}
