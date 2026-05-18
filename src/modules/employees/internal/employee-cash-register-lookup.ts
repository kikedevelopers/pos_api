import { UnprocessableEntityException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';

import type { Employee } from '../entities/employee.entity';

import { ensureMirrorUserForEmployee } from './ensure-mirror-user-for-employee.helper';

/**
 * Resuelve la caja PERMANENTE de un empleado.
 *
 * --------------------------------------------------------------------------
 * Pipeline (Fase 4A — User espejo)
 * --------------------------------------------------------------------------
 *
 * El modelo PERMANENTE de PlacePos ata la caja a `cash_registers.user_id`
 * (FK a `users`). Tras Fase 4A, `Employee.user_id` enlaza al User espejo:
 *
 *   1. Si `employee.user_id` NO es null → usa `getOrCreateCashRegisterForUser`
 *      directamente.
 *
 *   2. Si `employee.user_id` ES null Y `login_enabled = true` Y tiene
 *      credenciales completas (username + password) → creamos el User espejo
 *      on-the-fly con `ensureMirrorUserForEmployee` y luego resolvemos la
 *      caja con el nuevo `user_id`. Esto solo ocurre en el escenario raro
 *      donde el employee se habilitó para login pero nunca autenticó ni se
 *      ejecutó toggle-login (legacy data antes de Fase 4A).
 *
 *   3. Si `employee.user_id` ES null Y `login_enabled = false` → 422 con
 *      `code: EMPLOYEE_HAS_NO_CASH_REGISTER`. La caja por empleado solo
 *      tiene sentido cuando el empleado puede operar el POS, lo cual
 *      requiere `login_enabled = true`. Es 422 (no 400/404) porque el
 *      recurso existe (el employee) pero su estado de negocio (sin login
 *      configurado) impide la operación.
 *
 * --------------------------------------------------------------------------
 * Por qué centralizar aquí
 * --------------------------------------------------------------------------
 *
 * Las dos actions del módulo `employees` que tocan caja
 * (`set-employee-cash-base`, `adjust-employee-cash`) comparten esta
 * resolución. Centralizando el algoritmo, ambos endpoints heredan el mismo
 * comportamiento sin duplicación.
 *
 * --------------------------------------------------------------------------
 * Transacción
 * --------------------------------------------------------------------------
 *
 * Debe invocarse SIEMPRE dentro de `dataSource.transaction(...)`. El INSERT
 * potencial del User espejo + el UPDATE de `employees.user_id` + el lock
 * pesimista sobre `cash_registers` viven todos en el mismo manager.
 */
export async function getOrCreateEmployeeCashRegister(
  manager: EntityManager,
  employee: Employee,
  companyId: number,
): Promise<CashRegister> {
  let employeeUserId = extractEmployeeUserId(employee);

  if (employeeUserId === null) {
    if (
      employee.login_enabled === true &&
      employee.username !== null &&
      employee.password !== null
    ) {
      // Caso 2: materializamos el espejo on-the-fly.
      const mirrorUser = await ensureMirrorUserForEmployee({
        manager,
        employee,
        companyId,
      });
      employeeUserId = Number(mirrorUser.id);
    } else {
      // Caso 3: 422 EMPLOYEE_HAS_NO_CASH_REGISTER.
      throw new UnprocessableEntityException({
        message:
          'El empleado no tiene una caja registradora asociada. Habilite el login del empleado y asigne credenciales para poder operar su caja.',
        payload: { code: 'EMPLOYEE_HAS_NO_CASH_REGISTER' },
      });
    }
  }

  return getOrCreateCashRegisterForUser(manager, companyId, employeeUserId);
}

/**
 * Lee `user_id` del employee (mapeado como `string | null` por TypeORM).
 * Devuelve `number | null` listo para pasar a helpers que esperan number.
 */
function extractEmployeeUserId(employee: Employee): number | null {
  if (employee.user_id === null || employee.user_id === undefined) {
    return null;
  }
  const parsed = Number(employee.user_id);
  return Number.isFinite(parsed) ? parsed : null;
}
