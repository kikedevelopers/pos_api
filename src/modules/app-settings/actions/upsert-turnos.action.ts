import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { TurnosConfigDto, UpdateTurnosDto } from '../dto/turnos.dto';
import { getTurnosConfig, setTurnosConfig } from '../internal/turnos-config';

/**
 * Set de la configuración de TURNOS (`enabled` + `max`). El guard de admin
 * (`canAccessSettings`) vive en el controller. NO toca el contador: bajar el
 * tope por debajo del contador actual es válido — el siguiente turno reinicia
 * en 1 al superar el nuevo tope. Devuelve la config completa (incl. counter).
 */
@Injectable()
export class UpsertTurnosAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(dto: UpdateTurnosDto, companyId: number): Promise<TurnosConfigDto> {
    return this.dataSource.transaction(async (manager) => {
      await setTurnosConfig(manager, companyId, { enabled: dto.enabled, max: dto.max });
      return getTurnosConfig(manager, companyId);
    });
  }
}
