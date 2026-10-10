import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Employee } from '@/modules/employees/entities/employee.entity';
import {
  ResolveEffectivePermissionsAction,
  type PermissionActor,
} from './resolve-effective-permissions.action';

/**
 * Gate fail-closed de "cobrar pedidos" (ORDER→SALE, `POST /payments`).
 *
 * Capacidad efectiva = `owner/superadmin || rol concede canViewAllSales ||
 * employee.can_charge_orders`. El flag per-empleado actúa como OVERRIDE solo
 * para roles no elevados (Vendedor, empleado legacy): los roles con
 * `canViewAllSales` (Cajero/Admin) cobran igual aunque el flag esté en false.
 *
 * Lanza `ForbiddenException` (código `CHARGE_ORDERS_NOT_ALLOWED`) si el actor no
 * puede cobrar. Se invoca desde el controller de cobro (payments) ANTES de
 * ejecutar la operación.
 */
@Injectable()
export class AssertCanChargeOrdersAction {
  constructor(
    @InjectRepository(Employee)
    private readonly employeesRepo: Repository<Employee>,
    private readonly resolvePermissions: ResolveEffectivePermissionsAction,
  ) {}

  async execute(actor: PermissionActor): Promise<void> {
    // owner/superadmin siempre pueden.
    if (actor.type === 'owner' || actor.type === 'superadmin') return;

    // Rol elevado = concede canViewAllSales (Cajero/Admin). Reutiliza la misma
    // resolución que el scope de ventas para no divergir.
    const effective = await this.resolvePermissions.execute(actor);
    if (effective.includes('canViewAllSales')) return;

    // Rol no elevado (Vendedor/legacy): requiere el override per-empleado.
    if (actor.company_id !== null) {
      const employee = await this.employeesRepo.findOne({
        where: {
          user_id: String(actor.user_id),
          company_id: String(actor.company_id),
          is_archived: false,
        },
      });
      if (employee?.can_charge_orders) return;
    }

    throw new ForbiddenException({
      message:
        'Tu rol no permite cobrar pedidos. Pídele al administrador que active el permiso.',
      payload: { code: 'CHARGE_ORDERS_NOT_ALLOWED' },
    });
  }
}
