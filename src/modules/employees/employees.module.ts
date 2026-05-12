import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { Employee } from './entities/employee.entity';

/**
 * Módulo `employees`.
 *
 * Exporta `EmployeesService` para que `AuthService` pueda invocar
 * `findByUsername` en el flujo de login dual user/employee.
 *
 * `TypeOrmModule` también se exporta para que módulos que necesiten leer la
 * entidad (reportes, dashboard) inyecten su repositorio sin reabrir la
 * registración con `forFeature`. Patrón espejo del `UsersModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Employee])],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService, TypeOrmModule],
})
export class EmployeesModule {}
