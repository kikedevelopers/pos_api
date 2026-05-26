import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type FindOptionsWhere, ILike, Repository } from 'typeorm';

import type { ListDeliveryCompaniesQueryDto } from '../dto/list-delivery-companies-query.dto';
import { DeliveryCompany } from '../entities/delivery-company.entity';

/**
 * Lista los domiciliarios de una company. Filtros: `search` (ILIKE sobre
 * name) e `include_archived`.
 *
 * **Multi-tenancy**: filtro `company_id` SIEMPRE aplicado.
 *
 * **Performance**: el índice `(company_id, name)` cubre el orden por nombre.
 * El filtro por archivado se sirve por el índice parcial
 * `(company_id, name) WHERE is_archived = false`.
 */
@Injectable()
export class FindAllDeliveryCompaniesAction {
  constructor(
    @InjectRepository(DeliveryCompany)
    private readonly repo: Repository<DeliveryCompany>,
  ) {}

  execute(companyId: number, query: ListDeliveryCompaniesQueryDto): Promise<DeliveryCompany[]> {
    const includeArchived = query.include_archived === 'true';

    const where: FindOptionsWhere<DeliveryCompany> = { company_id: String(companyId) };

    if (!includeArchived) {
      where.is_archived = false;
    }

    if (query.search) {
      where.name = ILike(`%${query.search}%`);
    }

    return this.repo.find({
      where,
      order: { name: 'ASC', id: 'ASC' },
    });
  }
}
