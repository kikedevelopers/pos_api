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
   * Lookup por id dentro de una company. Si el id existe pero pertenece a
   * otra company (cross-tenant), retorna `null` — el caller debe traducirlo
   * a `NotFoundException` para no filtrar la existencia del recurso.
   *
   * Nota: la columna `company_id` se mapea como `string` (bigint en pg). El
   * `companyId` recibido como `number` se compara como string para no
   * depender de coerciones implícitas de TypeORM.
   */
  async findByIdInCompany(id: number, companyId: number): Promise<User | null> {
    return this.usersRepo.findOne({
      where: { id: String(id), company_id: String(companyId) },
    });
  }

  /**
   * Resuelve el perfil propio del owner (`GET /users/me`).
   */
  findMe(userId: number, companyId: number): Promise<User> {
    return this.findMeAction.execute(userId, companyId);
  }

  /**
   * Actualiza el perfil del usuario autenticado (`PUT /users/me`).
   */
  updateMe(userId: number, companyId: number, dto: UpdateMeDto): Promise<User> {
    return this.updateMeAction.execute(userId, companyId, dto);
  }

  /**
   * Cambia la contraseña del usuario autenticado (`PUT /users/me/password`).
   */
  changePassword(userId: number, companyId: number, dto: ChangePasswordDto): Promise<void> {
    return this.changePasswordAction.execute(userId, companyId, dto);
  }
}
