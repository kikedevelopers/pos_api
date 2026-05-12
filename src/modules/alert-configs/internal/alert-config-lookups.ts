import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { AlertConfig } from '../entities/alert-config.entity';

/**
 * Lookup de config por (company, type). Lanza `NotFoundException` si no
 * existe.
 */
export async function findConfigByType(
  manager: EntityManager,
  type: string,
  companyId: number,
): Promise<AlertConfig> {
  const config = await manager.findOne(AlertConfig, {
    where: { company_id: String(companyId), type },
  });
  if (!config) {
    throw new NotFoundException('Configuración de alerta no encontrada');
  }
  return config;
}
