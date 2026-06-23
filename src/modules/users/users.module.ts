import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AdminSignatureGuard } from '@/common/guards/admin-signature.guard';

import { ChangePasswordAction } from './actions/change-password.action';
import { FindMeAction } from './actions/find-me.action';
import { ListOwnersAction } from './actions/list-owners.action';
import { UpdateMeAction } from './actions/update-me.action';
import { AdminUsersController } from './admin-users.controller';
import { User } from './entities/user.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Módulo `users`.
 *
 * Expone:
 *   - `UsersService` con lookups (`findByEmail`, `findById`) usados por
 *     `AuthService` durante login/me y por el switch de sucursal.
 *   - `UsersController` con endpoints `/users/me` (GET/PUT/PUT password) para
 *     que el owner gestione su propia cuenta.
 *
 * NO expone listado ni gestión de empleados — ese flujo vive en
 * `EmployeesModule`. NO expone superadmin admin de users (no se implementa
 * por ahora; el superadmin gestiona via `/admin/*` cuando sea necesario).
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController, AdminUsersController],
  providers: [
    UsersService,
    FindMeAction,
    UpdateMeAction,
    ChangePasswordAction,
    ListOwnersAction,
    AdminSignatureGuard,
  ],
  // `ListOwnersAction` y `UpdateMeAction` se exportan para que `SuperadminModule`
  // reutilice, sin duplicar lógica, el listado cross-tenant de owners y la
  // edición de perfil del owner (paridad con `PUT /users/me`).
  exports: [UsersService, ListOwnersAction, UpdateMeAction, TypeOrmModule],
})
export class UsersModule {}
