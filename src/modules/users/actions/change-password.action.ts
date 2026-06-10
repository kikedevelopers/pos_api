import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';

import { ARGON2_OPTIONS } from '@/common/utils/argon2-options';

import type { ChangePasswordDto } from '../dto/change-password.dto';
import { User } from '../entities/user.entity';

/**
 * Cambia la contraseña del usuario autenticado (`PUT /users/me/password`).
 *
 * Reglas duras:
 *   1. `current_password` debe coincidir con el hash guardado. Si no → 401.
 *      Usamos `argon2.verify` con las mismas `ARGON2_OPTIONS` que `Login`.
 *   2. `new_password === confirm_password`. Si no → 400.
 *   3. `new_password !== current_password`. Política mínima de higiene
 *      para evitar "cambios" cosméticos que no rotan el hash.
 *
 * Side effects implícitos:
 *   - Tokens previos quedan vivos hasta su `exp` natural — el JWT es
 *     stateless. Si en el futuro se implementa revocación, hay que añadir
 *     un blacklist o subir el `iat` mínimo aceptado.
 *
 * §8.8 CLAUDE.md: transacción obligatoria. El hashing de la NUEVA password
 * se hace FUERA de la tx (paridad con `RegisterAction`) para no bloquear la
 * conexión del pool ~50-100ms; si la tx falla, el hash se descarta.
 */
@Injectable()
export class ChangePasswordAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(userId: number, dto: ChangePasswordDto): Promise<void> {
    if (dto.new_password !== dto.confirm_password) {
      throw new BadRequestException('La nueva contraseña y su confirmación no coinciden');
    }

    if (dto.new_password === dto.current_password) {
      throw new BadRequestException('La nueva contraseña debe ser distinta a la actual');
    }

    // Verificación previa fuera de la transacción: si current_password
    // no coincide, no abrimos tx. Argon2.verify es CPU-bound (~50ms).
    const currentUser = await this.dataSource.getRepository(User).findOne({
      where: { id: String(userId) },
    });

    if (!currentUser) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const isValid = await argon2.verify(currentUser.password, dto.current_password);
    if (!isValid) {
      throw new UnauthorizedException('La contraseña actual es incorrecta');
    }

    const newHash = await argon2.hash(dto.new_password, ARGON2_OPTIONS);

    await this.dataSource.transaction(async (manager) => {
      const result = await manager.update(User, { id: String(userId) }, { password: newHash });

      if (result.affected !== 1) {
        // Carrera improbable: el row desapareció entre la verificación y el
        // UPDATE. Lanzamos NotFound para mantener semántica consistente.
        throw new NotFoundException('Usuario no encontrado');
      }
    });
  }
}
