import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Employee } from '@/modules/employees/entities/employee.entity';

import { CreateRoleAction } from './actions/create-role.action';
import { DeleteRoleAction } from './actions/delete-role.action';
import { ListRolesAction } from './actions/list-roles.action';
import { ResolveEffectivePermissionsAction } from './actions/resolve-effective-permissions.action';
import { UpdateRoleAction } from './actions/update-role.action';
import { Role } from './entities/role.entity';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

/**
 * Módulo `roles` — FASE 2 (CRUD + resolución de permisos efectivos).
 *
 * Registra `Employee` en `forFeature` (además de `Role`) para que
 * `ResolveEffectivePermissionsAction` y el listado puedan leer la asignación
 * de roles a empleados sin acoplarse al `EmployeesModule` completo (evita
 * ciclos: `AuthModule` importa `RolesModule` para el perfil).
 *
 * Exporta `RolesService` para que `AuthModule` resuelva los permisos efectivos
 * en `GET /auth/profile`. `RolesModule` NO importa `AuthModule` → sin ciclo.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Role, Employee])],
  controllers: [RolesController],
  providers: [
    RolesService,
    ListRolesAction,
    CreateRoleAction,
    UpdateRoleAction,
    DeleteRoleAction,
    ResolveEffectivePermissionsAction,
  ],
  exports: [RolesService],
})
export class RolesModule {}
