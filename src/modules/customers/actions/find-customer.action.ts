import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type Repository } from 'typeorm';

import { Customer } from '@/modules/customers/entities/customer.entity';

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
    // Cargamos la relación `category` para que el detalle exponga la categoría
    // especial del cliente (id + nombre). Filtro por `id + company_id` —
    // anti-enumeración cross-tenant (404 si no existe o es de otra company).
    const customer = await this.repo.findOne({
      where: { id: String(id), company_id: String(companyId) },
      relations: { category: true },
    });
    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }
    return customer;
  }
}
