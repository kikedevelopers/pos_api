import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Delivery } from '../entities/delivery.entity';
import { DeliveryCompany } from '../entities/delivery-company.entity';

/**
 * Helpers internos del módulo `deliveries`. Centralizan lookups dentro del
 * tenant para que ningún caller olvide el filtro `company_id`.
 */

/**
 * Lookup de un domiciliario por id dentro de la company. Lanza
 * NotFoundException si no existe o pertenece a otra company —
 * anti-enumeración cross-tenant.
 *
 * `includeArchived`: si es `false`, exige `is_archived = false`.
 */
export async function findDeliveryCompanyInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
  options: { includeArchived?: boolean } = {},
): Promise<DeliveryCompany> {
  const where: { id: string; company_id: string; is_archived?: boolean } = {
    id: String(id),
    company_id: String(companyId),
  };
  if (options.includeArchived === false) {
    where.is_archived = false;
  }

  const company = await manager.findOne(DeliveryCompany, { where });
  if (!company) {
    throw new NotFoundException('Domiciliario no encontrado');
  }
  return company;
}

/**
 * Lookup de un domicilio por id dentro de la company. Lanza NotFoundException
 * si no existe o pertenece a otra company.
 *
 * Por defecto incluye archivados (las mutaciones de anulación necesitan leer
 * rows ya archivados para validar idempotencia; el listado público filtra
 * explícitamente).
 */
export async function findDeliveryInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
  options: { includeArchived?: boolean } = {},
): Promise<Delivery> {
  const where: { id: string; company_id: string; is_archived?: boolean } = {
    id: String(id),
    company_id: String(companyId),
  };
  if (options.includeArchived === false) {
    where.is_archived = false;
  }

  const delivery = await manager.findOne(Delivery, { where });
  if (!delivery) {
    throw new NotFoundException('Domicilio no encontrado');
  }
  return delivery;
}
