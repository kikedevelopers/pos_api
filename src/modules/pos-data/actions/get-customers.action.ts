import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Customer } from '@/modules/customers/entities/customer.entity';

export interface PosCustomer {
  id: number;
  name: string;
  address: string;
}

/**
 * `GET /pos-data/customers`. Listado plano de customers para typeahead del POS.
 *
 * Espejo PlacePos: solo id, name, address. Filtra archivados.
 *
 * Multi-tenancy: `where: { company_id }`.
 */
@Injectable()
export class GetCustomersAction {
  constructor(
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
  ) {}

  async execute(companyId: number): Promise<PosCustomer[]> {
    const customers = await this.customerRepo.find({
      where: { company_id: String(companyId), is_archived: false },
      select: { id: true, name: true, address: true },
      order: { name: 'ASC' },
    });
    return customers.map((c) => ({
      id: Number(c.id),
      name: c.name,
      address: c.address ?? '',
    }));
  }
}
