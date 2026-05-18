import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Product } from '@/modules/products/entities/product.entity';

/**
 * Lookup individual con relations. Endpoint `GET /inventory/:id`.
 *
 * Paridad PlacePos: el endpoint devuelve el producto SIN filtrar por
 * `is_archived` — el frontend puede pedir detalles de uno archivado para
 * verlo en historial.
 *
 * Multi-tenant: filtra por `company_id`. 404 si no existe o pertenece a
 * otra company (anti-enumeración).
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class FindProductByIdAction {
  constructor(
    @InjectRepository(Product)
    private readonly repo: Repository<Product>,
  ) {}

  async execute(id: number, companyId: number): Promise<Product | null> {
    return this.repo.findOne({
      where: { id: String(id), company_id: String(companyId) },
      relations: { prices: true, packaging: true, category: true },
    });
  }
}
