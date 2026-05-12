import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { AppSetting } from '../entities/app-setting.entity';

/**
 * Lee un setting por (company, key). Endpoint `GET /app-settings/:key`.
 *
 * 404 si no existe. PlacePos local devolvía un fallback ('white' para
 * `app_color_mode`) cuando la row no existía. Aquí asumimos que el seed
 * del `RegisterAction` siempre crea las claves por defecto, así que un
 * 404 indica una clave nueva no seedeada — el frontend debe interpretar
 * "no configurado" y mostrar default.
 */
@Injectable()
export class FindAppSettingByKeyAction {
  constructor(
    @InjectRepository(AppSetting)
    private readonly repo: Repository<AppSetting>,
  ) {}

  async execute(key: string, companyId: number): Promise<AppSetting> {
    const setting = await this.repo.findOne({
      where: { company_id: String(companyId), key },
    });
    if (!setting) {
      throw new NotFoundException('Setting no encontrado');
    }
    return setting;
  }
}
