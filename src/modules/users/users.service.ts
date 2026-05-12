import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { User } from './entities/user.entity';

/**
 * Servicio mínimo para Fase 1.
 *
 * Solo expone los lookups que `AuthService` necesita:
 *   - `findByEmail`: para `POST /auth/user` (login). Se busca SIN filtrar
 *     por `company_id` porque el email es UNIQUE global y el usuario aún no
 *     está autenticado. **Devuelve TODAS las columnas**, incluida `password`,
 *     porque el AuthService necesita compararlo con `argon2.verify`.
 *
 *   - `findByIdInCompany`: para `GET /auth/me` y `GET /auth/profile`. Filtra
 *     por `id` + `company_id` (lookup multi-tenant correcto). Devuelve `null`
 *     si no existe o si pertenece a otra company (404 cross-tenant).
 *
 * Cuando se cree `UsersController`, este service se ampliará con métodos
 * tipo `updateProfile`, `changePassword`, `list`, etc. Hoy ese código no
 * existe y NO debe forzarse.
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
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
}
