import { Injectable } from '@nestjs/common';

import { CreateEmployeeAction, type EmployeeCreator } from './actions/create-employee.action';
import { FindAllEmployeesAction } from './actions/find-all-employees.action';
import { FindEmployeeByUsernameAction } from './actions/find-employee-by-username.action';
import { ToggleEmployeeLoginAction } from './actions/toggle-employee-login.action';
import { UpdateEmployeeAction } from './actions/update-employee.action';
import { UpdateEmployeeCredentialsAction } from './actions/update-employee-credentials.action';
import type { CreateEmployeeDto } from './dto/create-employee.dto';
import type { UpdateCredentialsDto } from './dto/update-credentials.dto';
import type { UpdateEmployeeDto } from './dto/update-employee.dto';
import type { Employee } from './entities/employee.entity';

export type { EmployeeCreator } from './actions/create-employee.action';

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
    private readonly findEmployeeByUsernameAction: FindEmployeeByUsernameAction,
    private readonly createEmployeeAction: CreateEmployeeAction,
    private readonly updateEmployeeAction: UpdateEmployeeAction,
    private readonly updateEmployeeCredentialsAction: UpdateEmployeeCredentialsAction,
    private readonly toggleEmployeeLoginAction: ToggleEmployeeLoginAction,
  ) {}

  findAll(companyId: number): Promise<Employee[]> {
    return this.findAllEmployeesAction.execute(companyId);
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
}
