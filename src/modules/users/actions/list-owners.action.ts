import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { ListOwnersQueryDto } from '../dto/list-owners-query.dto';
import { User, UserType } from '../entities/user.entity';

export interface ListOwnersResult {
  owners: User[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Lista TODOS los usuarios `owner` con su company principal (cross-tenant).
 *
 * Acceso controlado por firma asimétrica en el controller (`AdminSignatureGuard`),
 * no por rol/tenant. Read puro — sin transacción.
 *
 * La búsqueda cruza owner (name/lastname/email) y company (name) vía ILIKE;
 * usa QueryBuilder porque el filtro toca la relación.
 */
@Injectable()
export class ListOwnersAction {
  constructor(
    @InjectRepository(User)
    private readonly repo: Repository<User>,
  ) {}

  async execute(query: ListOwnersQueryDto): Promise<ListOwnersResult> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const qb = this.repo
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.company', 'c')
      .where('u.type = :type', { type: UserType.OWNER });

    if (query.search) {
      qb.andWhere(
        '(u.name ILIKE :s OR u.lastname ILIKE :s OR u.email ILIKE :s OR c.name ILIKE :s)',
        { s: `%${query.search}%` },
      );
    }

    // Más recientes primero (por fecha de registro; id como desempate).
    qb.orderBy('u.created_at', 'DESC').addOrderBy('u.id', 'DESC').take(limit).skip(offset);

    const [owners, total] = await qb.getManyAndCount();

    return { owners, total, limit, offset };
  }
}
