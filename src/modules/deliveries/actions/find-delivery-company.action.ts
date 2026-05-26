import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DeliveryCompany } from '../entities/delivery-company.entity';
import { findDeliveryCompanyInCompany } from '../internal/delivery-lookups';

/**
 * Devuelve el detalle de un domiciliario. Lanza NotFoundException si no existe
 * o pertenece a otra company.
 */
@Injectable()
export class FindDeliveryCompanyAction {
  constructor(
    @InjectRepository(DeliveryCompany)
    private readonly repo: Repository<DeliveryCompany>,
  ) {}

  execute(id: number, companyId: number): Promise<DeliveryCompany> {
    return findDeliveryCompanyInCompany(this.repo.manager, id, companyId);
  }
}
