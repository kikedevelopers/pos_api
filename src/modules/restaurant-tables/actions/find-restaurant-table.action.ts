import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { RestaurantTable } from '../entities/restaurant-table.entity';
import { findRestaurantTableInCompany } from '../internal/restaurant-table-lookups';

/** Lookup individual (`GET /restaurant-tables/:id`). 404 cross-tenant. */
@Injectable()
export class FindRestaurantTableAction {
  constructor(
    @InjectRepository(RestaurantTable)
    private readonly repo: Repository<RestaurantTable>,
  ) {}

  execute(id: number, companyId: number): Promise<RestaurantTable> {
    return findRestaurantTableInCompany(this.repo.manager, id, companyId);
  }
}
