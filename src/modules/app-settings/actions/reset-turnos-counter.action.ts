import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { TurnosConfigDto } from '../dto/turnos.dto';
import { getTurnosConfig, resetTurnosCounter } from '../internal/turnos-config';

/**
 * Reinicia el contador de turnos a 0 (el próximo turno asignado será 1). Útil
 * al abrir el día. No cambia `enabled` ni `max`. Devuelve la config resultante.
 */
@Injectable()
export class ResetTurnosCounterAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<TurnosConfigDto> {
    return this.dataSource.transaction(async (manager) => {
      await resetTurnosCounter(manager, companyId);
      return getTurnosConfig(manager, companyId);
    });
  }
}
