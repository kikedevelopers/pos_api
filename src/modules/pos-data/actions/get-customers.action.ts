import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Customer } from '@/modules/customers/entities/customer.entity';

export interface PosCustomer {
  id: number;
  name: string;
  address: string;
  advance_balance: number;
}

/**
 * `GET /pos-data/customers`. Listado plano de customers para typeahead del POS.
 *
 * Espejo PlacePos: id, name, address y advance_balance (saldo a favor del
 * cliente, para pintar el chip de anticipo y habilitar el medio de pago
 * ADVANCE en el cobro). Filtra archivados.
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
      select: { id: true, name: true, address: true, advance_balance: true },
      order: { name: 'ASC' },
    });
    return customers.map((c) => ({
      id: Number(c.id),
      name: c.name,
      address: c.address ?? '',
      advance_balance: Number(c.advance_balance ?? 0),
    }));
  }
}
