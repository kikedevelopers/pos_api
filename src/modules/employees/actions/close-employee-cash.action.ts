import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  CloseCashAction,
  type CloseCashActor,
  type CloseCashResult,
} from '@/modules/pos-data/actions/close-cash.action';
import type { CloseCashDto } from '@/modules/pos-data/dto/close-cash.dto';

import { getOrCreateEmployeeCashRegister } from '../internal/employee-cash-register-lookup';
import { findEmployeeInCompany } from '../internal/employee-lookups';

/**
 * `POST /employees/:id/cash-register/close` — el admin (owner) cierra la caja de
 * un empleado. Reutiliza ÍNTEGRAMENTE `CloseCashAction` (modos simple/conciliación,
 * dos movimientos, sobrante/faltante, idempotencia) pero apuntando a la caja del
 * empleado en vez de a la del actor. `created_by`/`created_by_id` de los logs y
 * movimientos siguen siendo el ADMIN que ejecuta; solo cambian el register
 * objetivo y su etiqueta (`Caja de <empleado>`).
 */
@Injectable()
export class CloseEmployeeCashAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly closeCashAction: CloseCashAction,
  ) {}

  async execute(
    id: number,
    companyId: number,
    dto: CloseCashDto,
    actor: CloseCashActor,
    idempotencyKey: string | null = null,
  ): Promise<CloseCashResult> {
    // Resolver el empleado + materializar su caja para obtener user_id y nombre.
    // Lanza 404 si no existe, 422 EMPLOYEE_HAS_NO_CASH_REGISTER si no tiene caja.
    const { employeeName, targetUserId } = await this.dataSource.transaction(async (manager) => {
      const employee = await findEmployeeInCompany(manager, id, companyId);
      const register = await getOrCreateEmployeeCashRegister(manager, employee, companyId);
      return { employeeName: employee.name, targetUserId: Number(register.user_id) };
    });

    return this.closeCashAction.execute(dto, companyId, actor, idempotencyKey, {
      targetUserId,
      targetLabel: `Caja de ${employeeName}`,
    });
  }
}
