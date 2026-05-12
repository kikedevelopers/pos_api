import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CreateEmployeeAction } from './actions/create-employee.action';
import { FindAllEmployeesAction } from './actions/find-all-employees.action';
import { FindEmployeeByUsernameAction } from './actions/find-employee-by-username.action';
import { ToggleEmployeeLoginAction } from './actions/toggle-employee-login.action';
import { UpdateEmployeeAction } from './actions/update-employee.action';
import { UpdateEmployeeCredentialsAction } from './actions/update-employee-credentials.action';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { Employee } from './entities/employee.entity';

/**
 * Módulo `employees`.
 *
 * Cablea las 6 actions del dominio + el service facade. El service se exporta
 * para que `AuthService` pueda invocar `findByUsername` en el flujo de login
 * dual user/employee. `TypeOrmModule` también se exporta para que módulos que
 * necesiten leer la entidad (reportes, dashboard) inyecten su repositorio sin
 * reabrir la registración con `forFeature`. Patrón espejo del `UsersModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Employee])],
  controllers: [EmployeesController],
  providers: [
    EmployeesService,
    FindAllEmployeesAction,
    FindEmployeeByUsernameAction,
    CreateEmployeeAction,
    UpdateEmployeeAction,
    UpdateEmployeeCredentialsAction,
    ToggleEmployeeLoginAction,
  ],
  exports: [EmployeesService, TypeOrmModule],
})
export class EmployeesModule {}
