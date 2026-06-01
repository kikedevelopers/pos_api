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
 *   - `UsersService` con lookups (`findByEmail`, `findByIdInCompany`) usados
 *     por `AuthService` durante login/me.
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
  // `ListOwnersAction` se exporta para que `SuperadminModule` reutilice el
  // listado cross-tenant de owners sin duplicar la query.
  exports: [UsersService, ListOwnersAction, TypeOrmModule],
})
export class UsersModule {}
