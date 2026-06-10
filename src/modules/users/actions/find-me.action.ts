import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { User } from '../entities/user.entity';

/**
 * Resuelve al usuario autenticado (owner) en su company.
 *
 * Multi-tenant: filtra por `id` + `company_id` para no exponer datos cross-
 * tenant si el JWT viniera corrupto. El controller debe usar este endpoint
 * solo para owners (ver `@Roles('owner')` en `UsersController`); employees
 * tienen su propia tabla y usan `GET /auth/profile`.
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class FindMeAction {
  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  async execute(userId: number): Promise<User> {
    // Solo por id: la cuenta del owner es única y el company_id del JWT puede
    // ser una sucursal no-primaria (multi-sucursal). Restringido por @Roles.
    const user = await this.usersRepo.findOne({
      where: { id: String(userId) },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return user;
  }
}
