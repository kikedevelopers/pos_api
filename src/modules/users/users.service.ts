import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { ChangePasswordAction } from './actions/change-password.action';
import { FindMeAction } from './actions/find-me.action';
import { UpdateMeAction } from './actions/update-me.action';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { UpdateMeDto } from './dto/update-me.dto';
import { User } from './entities/user.entity';

/**
 * Servicio del dominio `users`.
 *
 * Composición:
 *   - Lookups planos (`findByEmail`, `findByIdInCompany`) usados por
 *     `AuthService` para el flujo de login y `GET /auth/me`.
 *   - Facade de las actions del controller propio (`/users/me`, password).
 *
 * El service no contiene lógica de negocio: cada operación se delega a una
 * action dedicada (§3.1 CLAUDE.md).
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly findMeAction: FindMeAction,
    private readonly updateMeAction: UpdateMeAction,
    private readonly changePasswordAction: ChangePasswordAction,
  ) {}

  /**
   * Lookup plano por email (UNIQUE global). Usado por el flujo de login.
   * Retorna `null` si no existe.
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { email } });
  }

  /**
   * Lookup por id del usuario, SIN filtrar por company. La cuenta del owner es
   * única (un solo `User` por owner), y con multi-sucursal el `company_id` del
   * JWT puede ser cualquiera de sus sucursales — no la primaria. Filtrar por
   * company aquí rompería `/users/me` y `/auth/me|profile` al operar una
   * sucursal no-primaria. El acceso queda restringido por `@Roles('owner')`.
   */
  async findById(id: number): Promise<User | null> {
    return this.usersRepo.findOne({ where: { id: String(id) } });
  }

  /**
   * Resuelve el perfil propio del owner (`GET /users/me`).
   */
  findMe(userId: number): Promise<User> {
    return this.findMeAction.execute(userId);
  }

  /**
   * Actualiza el perfil del usuario autenticado (`PUT /users/me`).
   */
  updateMe(userId: number, dto: UpdateMeDto): Promise<User> {
    return this.updateMeAction.execute(userId, dto);
  }

  /**
   * Cambia la contraseña del usuario autenticado (`PUT /users/me/password`).
   */
  changePassword(userId: number, dto: ChangePasswordDto): Promise<void> {
    return this.changePasswordAction.execute(userId, dto);
  }
}
