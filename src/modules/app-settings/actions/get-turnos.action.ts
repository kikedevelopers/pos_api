import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { TurnosConfigDto } from '../dto/turnos.dto';
import { getTurnosConfig } from '../internal/turnos-config';

/**
 * Lee la configuración de TURNOS de la company (`{ enabled, max, counter }`).
 * Default `enabled=false, max=99, counter=0` si las keys no existen.
 */
@Injectable()
export class GetTurnosAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<TurnosConfigDto> {
    return getTurnosConfig(this.dataSource.manager, companyId);
  }
}
