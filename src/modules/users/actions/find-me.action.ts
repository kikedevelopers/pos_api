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

  async execute(userId: number, companyId: number): Promise<User> {
    const user = await this.usersRepo.findOne({
      where: { id: String(userId), company_id: String(companyId) },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return user;
  }
}
