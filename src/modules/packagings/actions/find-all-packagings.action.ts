import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Packaging } from '@/modules/packagings/entities/packaging.entity';

/**
 * Lista empaques ACTIVOS (`is_archived = false`) de una company,
 * ordenados por `name ASC`. Endpoint `GET /packagings`.
 *
 * Paridad PlacePos: espeja `packagings.routes.ts` (`ORDER BY name ASC`).
 * El frontend muestra los empaques alfabéticamente; cualquier cambio rompe
 * la regla #1 (paridad byte-por-byte).
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class FindAllPackagingsAction {
  constructor(
    @InjectRepository(Packaging)
    private readonly repo: Repository<Packaging>,
  ) {}

  async execute(companyId: number): Promise<Packaging[]> {
    return this.repo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { name: 'ASC' },
    });
  }
}
