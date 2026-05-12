import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from './entities/user.entity';
import { UsersService } from './users.service';

/**
 * Módulo `users` — versión mínima de Fase 1.
 *
 * Expone `UsersService` con lookup por email (usado por `AuthService.login`)
 * y por id+company_id (usado por `AuthService.getMe`/`getProfile`).
 *
 * TODO(Fase futura del dominio `users`): añadir `UsersController` con
 * endpoints de gestión cuando se requiera (cambio de password, actualización
 * de perfil, listado para superadmin, etc).
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService],
  exports: [UsersService, TypeOrmModule],
})
export class UsersModule {}
