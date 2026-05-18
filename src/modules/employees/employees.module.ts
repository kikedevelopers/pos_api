import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';

import { AdjustEmployeeCashAction } from './actions/adjust-employee-cash.action';
import { CreateEmployeeAction } from './actions/create-employee.action';
import { FindAllEmployeesAction } from './actions/find-all-employees.action';
import { FindEmployeeByIdAction } from './actions/find-employee-by-id.action';
import { FindEmployeeByUsernameAction } from './actions/find-employee-by-username.action';
import { SetEmployeeCashBaseAction } from './actions/set-employee-cash-base.action';
import { ToggleEmployeeLoginAction } from './actions/toggle-employee-login.action';
import { UpdateEmployeeAction } from './actions/update-employee.action';
import { UpdateEmployeeCredentialsAction } from './actions/update-employee-credentials.action';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { Employee } from './entities/employee.entity';

/**
 * Módulo `employees`.
 *
 * Cablea las 9 actions del dominio + el service facade. El service se exporta
 * para que `AuthService` pueda invocar `findByUsername` en el flujo de login
 * dual user/employee. `TypeOrmModule` también se exporta para que módulos que
 * necesiten leer la entidad (reportes, dashboard) inyecten su repositorio sin
 * reabrir la registración con `forFeature`. Patrón espejo del `UsersModule`.
 *
 * Dependencias:
 *   - `CashRegisterModule`: para resolver/lockear el cash_register del
 *     empleado al fijar base o ajustar balance.
 *   - `FinancialMovementsModule`: para registrar el `ADJUSTMENT` financiero
 *     en el flujo de adjust.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Employee]), CashRegisterModule, FinancialMovementsModule],
  controllers: [EmployeesController],
  providers: [
    EmployeesService,
    FindAllEmployeesAction,
    FindEmployeeByIdAction,
    FindEmployeeByUsernameAction,
    CreateEmployeeAction,
    UpdateEmployeeAction,
    UpdateEmployeeCredentialsAction,
    ToggleEmployeeLoginAction,
    SetEmployeeCashBaseAction,
    AdjustEmployeeCashAction,
  ],
  exports: [EmployeesService, TypeOrmModule],
})
export class EmployeesModule {}
