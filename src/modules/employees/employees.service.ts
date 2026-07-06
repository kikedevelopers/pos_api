import { Injectable } from '@nestjs/common';

import {
  AdjustEmployeeCashAction,
  type AdjustEmployeeCashActor,
  type AdjustEmployeeCashResult,
} from './actions/adjust-employee-cash.action';
import { ArchiveEmployeeAction } from './actions/archive-employee.action';
import { CreateEmployeeAction, type EmployeeCreator } from './actions/create-employee.action';
import {
  FindAllEmployeesAction,
  type EmployeeWithCashSummary,
} from './actions/find-all-employees.action';
import {
  FindEmployeeByIdAction,
  type EmployeeWithCashRegister,
} from './actions/find-employee-by-id.action';
import { FindEmployeeByUsernameAction } from './actions/find-employee-by-username.action';
import { RestoreEmployeeAction } from './actions/restore-employee.action';
import {
  SetEmployeeCashBaseAction,
  type SetEmployeeCashBaseResult,
} from './actions/set-employee-cash-base.action';
import {
  ProfitVisibilityPatch,
  SetEmployeeProfitVisibilityAction,
} from './actions/set-employee-profit-visibility.action';
import { SetEmployeeCashVisibilityAction } from './actions/set-employee-cash-visibility.action';
import { GetEmployeeCashLogsAction } from './actions/get-employee-cash-logs.action';
import { ToggleEmployeeLoginAction } from './actions/toggle-employee-login.action';
import { UpdateEmployeeAction } from './actions/update-employee.action';
import { UpdateEmployeeCredentialsAction } from './actions/update-employee-credentials.action';
import type { CreateEmployeeDto } from './dto/create-employee.dto';
import type { UpdateCredentialsDto } from './dto/update-credentials.dto';
import type { UpdateEmployeeDto } from './dto/update-employee.dto';
import type { Employee } from './entities/employee.entity';

export type { EmployeeCreator } from './actions/create-employee.action';
export type { EmployeeWithCashSummary } from './actions/find-all-employees.action';
export type { EmployeeWithCashRegister } from './actions/find-employee-by-id.action';
export type {
  AdjustEmployeeCashActor,
  AdjustEmployeeCashResult,
} from './actions/adjust-employee-cash.action';
export type { SetEmployeeCashBaseResult } from './actions/set-employee-cash-base.action';

/**
 * Facade delgado del dominio `employees`. ZERO lógica de negocio — solo
 * delega a la action correspondiente. Patrón §3.1 del CLAUDE.md.
 *
 * Razón de existir: el controller inyecta UN service (firma estable del
 * contrato HTTP). Los tests unitarios apuntan a las actions (que sí tienen
 * lógica); los e2e cubren el service por debajo.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly findAllEmployeesAction: FindAllEmployeesAction,
    private readonly findEmployeeByIdAction: FindEmployeeByIdAction,
    private readonly findEmployeeByUsernameAction: FindEmployeeByUsernameAction,
    private readonly createEmployeeAction: CreateEmployeeAction,
    private readonly updateEmployeeAction: UpdateEmployeeAction,
    private readonly updateEmployeeCredentialsAction: UpdateEmployeeCredentialsAction,
    private readonly toggleEmployeeLoginAction: ToggleEmployeeLoginAction,
    private readonly setEmployeeCashBaseAction: SetEmployeeCashBaseAction,
    private readonly setEmployeeProfitVisibilityAction: SetEmployeeProfitVisibilityAction,
    private readonly setEmployeeCashVisibilityAction: SetEmployeeCashVisibilityAction,
    private readonly getEmployeeCashLogsAction: GetEmployeeCashLogsAction,
    private readonly adjustEmployeeCashAction: AdjustEmployeeCashAction,
    private readonly archiveEmployeeAction: ArchiveEmployeeAction,
    private readonly restoreEmployeeAction: RestoreEmployeeAction,
  ) {}

  findAll(companyId: number, includeArchived = false): Promise<EmployeeWithCashSummary[]> {
    return this.findAllEmployeesAction.execute(companyId, includeArchived);
  }

  findOne(id: number, companyId: number): Promise<EmployeeWithCashRegister> {
    return this.findEmployeeByIdAction.execute(id, companyId);
  }

  findByUsername(username: string): Promise<Employee | null> {
    return this.findEmployeeByUsernameAction.execute(username);
  }

  create(dto: CreateEmployeeDto, companyId: number, createdBy: EmployeeCreator): Promise<Employee> {
    return this.createEmployeeAction.execute(dto, companyId, createdBy);
  }

  update(id: number, dto: UpdateEmployeeDto, companyId: number): Promise<Employee> {
    return this.updateEmployeeAction.execute(id, dto, companyId);
  }

  updateCredentials(
    id: number,
    dto: UpdateCredentialsDto,
    companyId: number,
    actorId: number,
  ): Promise<Employee> {
    return this.updateEmployeeCredentialsAction.execute(id, dto, companyId, actorId);
  }

  toggleLogin(id: number, enabled: boolean, companyId: number, actorId: number): Promise<Employee> {
    return this.toggleEmployeeLoginAction.execute(id, enabled, companyId, actorId);
  }

  setCashBase(
    id: number,
    baseAmount: number,
    companyId: number,
  ): Promise<SetEmployeeCashBaseResult> {
    return this.setEmployeeCashBaseAction.execute(id, baseAmount, companyId);
  }

  setProfitVisibility(
    id: number,
    patch: ProfitVisibilityPatch,
    companyId: number,
  ): Promise<Employee> {
    return this.setEmployeeProfitVisibilityAction.execute(id, patch, companyId);
  }

  setCashVisibility(id: number, canViewCash: boolean, companyId: number): Promise<Employee> {
    return this.setEmployeeCashVisibilityAction.execute(id, canViewCash, companyId);
  }

  getCashLogs(id: number, companyId: number, limit: number) {
    return this.getEmployeeCashLogsAction.execute(id, companyId, limit);
  }

  adjustCash(
    id: number,
    companyId: number,
    targetBalance: number,
    reason: string | undefined,
    actor: AdjustEmployeeCashActor,
  ): Promise<AdjustEmployeeCashResult> {
    return this.adjustEmployeeCashAction.execute(id, companyId, targetBalance, reason, actor);
  }

  archive(id: number, companyId: number, actorId: number): Promise<Employee> {
    return this.archiveEmployeeAction.execute(id, companyId, actorId);
  }

  restore(id: number, companyId: number, actorId: number): Promise<Employee> {
    return this.restoreEmployeeAction.execute(id, companyId, actorId);
  }
}
