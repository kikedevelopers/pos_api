import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CashRegisterModule } from '@/modules/cash-register/cash-register.module';
import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { PosDataModule } from '@/modules/pos-data/pos-data.module';

import { AdjustEmployeeCashAction } from './actions/adjust-employee-cash.action';
import { CloseEmployeeCashAction } from './actions/close-employee-cash.action';
import { ArchiveEmployeeAction } from './actions/archive-employee.action';
import { CreateEmployeeAction } from './actions/create-employee.action';
import { FindAllEmployeesAction } from './actions/find-all-employees.action';
import { FindEmployeeByIdAction } from './actions/find-employee-by-id.action';
import { FindEmployeeByUsernameAction } from './actions/find-employee-by-username.action';
import { RestoreEmployeeAction } from './actions/restore-employee.action';
import { SetEmployeeCashBaseAction } from './actions/set-employee-cash-base.action';
import { SetEmployeeProfitVisibilityAction } from './actions/set-employee-profit-visibility.action';
import { SetEmployeeCashVisibilityAction } from './actions/set-employee-cash-visibility.action';
import { GetEmployeeCashLogsAction } from './actions/get-employee-cash-logs.action';
import { ToggleEmployeeLoginAction } from './actions/toggle-employee-login.action';
import { UpdateEmployeeAction } from './actions/update-employee.action';
import { UpdateEmployeeCredentialsAction } from './actions/update-employee-credentials.action';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { Employee } from './entities/employee.entity';

/**
 * Módulo `employees`.
 *
 * Cablea las 11 actions del dominio + el service facade. El service se exporta
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
  imports: [
    TypeOrmModule.forFeature([Employee]),
    CashRegisterModule,
    FinancialMovementsModule,
    // Reutiliza CloseCashAction (cierre de caja) para el cierre de la caja de un
    // empleado desde el admin, sin duplicar la lógica de dinero.
    PosDataModule,
  ],
  controllers: [EmployeesController],
  providers: [
    EmployeesService,
    CloseEmployeeCashAction,
    FindAllEmployeesAction,
    FindEmployeeByIdAction,
    FindEmployeeByUsernameAction,
    CreateEmployeeAction,
    UpdateEmployeeAction,
    UpdateEmployeeCredentialsAction,
    ToggleEmployeeLoginAction,
    SetEmployeeCashBaseAction,
    SetEmployeeProfitVisibilityAction,
    SetEmployeeCashVisibilityAction,
    GetEmployeeCashLogsAction,
    AdjustEmployeeCashAction,
    ArchiveEmployeeAction,
    RestoreEmployeeAction,
  ],
  exports: [EmployeesService, TypeOrmModule],
})
export class EmployeesModule {}
