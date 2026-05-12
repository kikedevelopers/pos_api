import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type Repository } from 'typeorm';

import { Customer } from '@/modules/customers/entities/customer.entity';

import { findCustomerInCompany } from '../internal/customer-lookups';

/**
 * Lectura por id (`GET /customers/:id`).
 *
 * Read puro fuera de transacción — usamos el repo directo y delegamos en
 * `findCustomerInCompany` que aplica el filtro `id + company_id`.
 *
 * Paridad PlacePos: el endpoint local NO filtra por `is_archived`; aquí
 * tampoco — un customer archivado todavía debe ser consultable por id (p.ej.
 * para mostrar histórico). El listado SÍ los oculta por defecto.
 */
@Injectable()
export class FindCustomerAction {
  constructor(
    @InjectRepository(Customer)
    private readonly repo: Repository<Customer>,
  ) {}

  async execute(id: number, companyId: number): Promise<Customer> {
    return findCustomerInCompany(this.repo.manager, id, companyId);
  }
}
