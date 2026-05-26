import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Delivery } from '../entities/delivery.entity';
import { findDeliveryInCompany } from '../internal/delivery-lookups';

/**
 * Devuelve el detalle de un domicilio. Lanza NotFoundException si no existe o
 * pertenece a otra company.
 */
@Injectable()
export class FindDeliveryAction {
  constructor(
    @InjectRepository(Delivery)
    private readonly repo: Repository<Delivery>,
  ) {}

  execute(id: number, companyId: number): Promise<Delivery> {
    return findDeliveryInCompany(this.repo.manager, id, companyId);
  }
}
