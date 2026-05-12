import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { AppAlert } from '../entities/app-alert.entity';

/**
 * Lookup alerta por id dentro de una company. Lanza `NotFoundException`
 * (mensaje genérico anti-enumeración) si no existe o pertenece a otra
 * company.
 */
export async function findAlertInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
): Promise<AppAlert> {
  const alert = await manager.findOne(AppAlert, {
    where: { id: String(id), company_id: String(companyId) },
  });
  if (!alert) {
    throw new NotFoundException('Alerta no encontrada');
  }
  return alert;
}
