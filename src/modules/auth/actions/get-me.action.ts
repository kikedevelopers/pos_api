import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { UsersService } from '@/modules/users/users.service';

import type { AuthUserDto } from '../dto/auth-response.dto';
import { userToAuthUserDto } from '../internal/auth-mappers';

/**
 * `GET /auth/me`. Para `owner`/`manager`/`employee` busca el user actual en DB
 * y retorna el snapshot. Para `superadmin` retorna lo que viene en el JWT (no
 * hay company que validar).
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class GetMeAction {
  private readonly logger = new Logger(GetMeAction.name);

  constructor(private readonly usersService: UsersService) {}

  async execute(authUser: AuthUser): Promise<AuthUserDto> {
    if (authUser.type === 'superadmin' || authUser.company_id === null) {
      return {
        id: authUser.user_id,
        name: authUser.name,
        lastname: authUser.lastname,
        email: null,
        type: authUser.type,
      };
    }

    const user = await this.usersService.findByIdInCompany(authUser.user_id, authUser.company_id);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return userToAuthUserDto(user, this.logger);
  }
}
