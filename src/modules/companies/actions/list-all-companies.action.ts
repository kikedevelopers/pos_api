import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, type FindOptionsWhere, Repository } from 'typeorm';

import type { ListCompaniesQueryDto } from '../dto/list-companies-query.dto';
import { Company } from '../entities/company.entity';

/**
 * Resultado paginado del listado superadmin.
 */
export interface ListAllCompaniesResult {
  companies: Company[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Lista TODAS las companies de la plataforma (cross-tenant).
 *
 * **Solo accesible para `superadmin`.** El controller debe enforced eso vía
 * `@Roles('superadmin')`; este action confía en el caller.
 *
 * Performance: el índice `idx_companies_name` (B-tree sobre `name`) ayuda a
 * `ORDER BY name`. Si en el futuro la tabla crece a >100k rows, considerar
 * un índice trigram (`pg_trgm`) para acelerar `ILIKE '%search%'` — por ahora
 * no se justifica.
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class ListAllCompaniesAction {
  constructor(
    @InjectRepository(Company)
    private readonly repo: Repository<Company>,
  ) {}

  async execute(query: ListCompaniesQueryDto): Promise<ListAllCompaniesResult> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const where: FindOptionsWhere<Company> = {};
    if (query.search) {
      where.name = ILike(`%${query.search}%`);
    }

    const [rows, total] = await this.repo.findAndCount({
      where,
      order: { name: 'ASC', id: 'ASC' },
      take: limit,
      skip: offset,
    });

    return {
      companies: rows,
      total,
      limit,
      offset,
    };
  }
}
