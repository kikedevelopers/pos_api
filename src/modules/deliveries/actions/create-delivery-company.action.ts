import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { CreateDeliveryCompanyDto } from '../dto/create-delivery-company.dto';
import { DeliveryCompany } from '../entities/delivery-company.entity';
import type { DeliveryActor } from '../internal/delivery-cash.helper';

/**
 * Crea un domiciliario. `company_id` siempre viene del JWT (parámetro), nunca
 * del payload. `phones` se normaliza (trim) y se persiste como jsonb.
 */
@Injectable()
export class CreateDeliveryCompanyAction {
  private readonly logger = new Logger(CreateDeliveryCompanyAction.name);

  constructor(
    @InjectRepository(DeliveryCompany)
    private readonly repo: Repository<DeliveryCompany>,
  ) {}

  async execute(
    dto: CreateDeliveryCompanyDto,
    companyId: number,
    actor: DeliveryActor,
  ): Promise<DeliveryCompany> {
    const phones = normalizePhones(dto.phones);

    const entity = this.repo.create({
      company_id: String(companyId),
      name: dto.name.trim(),
      address: dto.address?.trim() ? dto.address.trim() : null,
      phones,
      is_archived: false,
      created_by: actor.fullName,
      created_by_id: String(actor.id),
    });
    const saved = await this.repo.save(entity);

    this.logger.log({
      event: 'delivery_company.created',
      companyId,
      deliveryCompanyId: Number(saved.id),
      actorId: actor.id,
    });

    return saved;
  }
}

/**
 * Normaliza la lista de teléfonos: trim de cada uno y descarta vacíos. La
 * validación de tamaño máx (4) la hace el DTO (`@ArrayMaxSize`).
 */
export function normalizePhones(phones: string[]): string[] {
  return phones.map((p) => p.trim()).filter((p) => p.length > 0);
}
