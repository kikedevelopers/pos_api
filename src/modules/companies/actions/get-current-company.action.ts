import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Company } from '../entities/company.entity';

/**
 * Devuelve la Company autenticada (la del JWT).
 *
 * Espejo de PlacePos `GET /companies`, con la diferencia conceptual de que
 * PlacePos lee "la única" (`findOne({ where: {} })`) y nosotros leemos
 * exactamente la del tenant. El shape de respuesta es idéntico.
 *
 * 404 solo debería disparar si el JWT trae un `company_id` huérfano (registro
 * abortado en medio, borrado manual en DB, etc.). En operación normal no
 * sucede.
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class GetCurrentCompanyAction {
  constructor(
    @InjectRepository(Company)
    private readonly repo: Repository<Company>,
  ) {}

  async execute(companyId: number): Promise<Company> {
    const company = await this.repo.findOne({
      where: { id: String(companyId) },
    });

    if (!company) {
      throw new NotFoundException('No se encontró información de la empresa');
    }

    return company;
  }
}
