import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { Customer } from '@/modules/customers/entities/customer.entity';

import type { LendingCustomer, LendingCustomersPort } from '../../ports/lending-customers.port';
import type { LendingTx } from '../../ports/lending-tx';

/** Clientes del POS vistos desde préstamos (solo lectura). */
@Injectable()
export class PosCustomersAdapter implements LendingCustomersPort {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findActive(companyId: number, customerId: number, tx?: LendingTx): Promise<LendingCustomer | null> {
    const manager = tx ?? this.dataSource.manager;
    const customer = await manager.findOne(Customer, {
      where: { id: String(customerId), company_id: String(companyId), is_archived: false },
      select: { id: true, name: true },
    });
    return customer ? { id: Number(customer.id), name: customer.name } : null;
  }

  async namesByIds(companyId: number, customerIds: number[]): Promise<Map<number, string>> {
    const ids = [...new Set(customerIds)];
    if (ids.length === 0) return new Map();
    const rows = await this.dataSource.manager.find(Customer, {
      where: { company_id: String(companyId), id: In(ids.map(String)) },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [Number(row.id), row.name]));
  }
}
