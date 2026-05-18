import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Raw, type Repository } from 'typeorm';

import { User } from '@/modules/users/entities/user.entity';

import type { CheckEmailDto, CheckEmailResponseDto } from '../dto/check-email.dto';

/**
 * `POST /auth/check/email` — paridad cliente PlacePos.
 *
 * El frontend lo usa antes de invocar `POST /auth/register` para mostrar al
 * usuario si el email ya está tomado. La búsqueda es:
 *
 *   - **Cross-company** por diseño: el email es UNIQUE GLOBAL en `users`
 *     (Fase 0). Cualquier conflicto bloquea el registro independientemente
 *     de la company.
 *   - **Case-insensitive**: usamos `LOWER(email) = LOWER($1)` para cubrir
 *     emails grabados con casing distinto al de la consulta. El DTO ya
 *     normaliza a minúsculas, pero el storage no garantiza la invariante.
 *
 * Read-only — no requiere transacción.
 */
@Injectable()
export class CheckEmailAction {
  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  async execute(dto: CheckEmailDto): Promise<CheckEmailResponseDto> {
    const count = await this.usersRepo.count({
      where: {
        email: Raw((alias) => `LOWER(${alias}) = LOWER(:email)`, { email: dto.email }),
      },
    });
    const available = count === 0;
    return {
      available,
      message: available ? 'Disponible' : 'Este correo ya está registrado',
    };
  }
}
