import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { PosMode } from '@/common/pos-mode/pos-mode.util';
import { Company } from '@/modules/companies/entities/company.entity';

import type { UpdatePosModeDto } from '../dto/update-pos-mode.dto';

export interface UpdatePosModeResult {
  pos_mode: PosMode;
}

/**
 * Cambia el modo del POS de un negocio (`retail` | `restaurant`) desde el panel
 * superadmin (firmado). Setea `companies.pos_mode`.
 *
 * A diferencia de la FE o del gating de sucursales, el modo SÍ se administra
 * por company, sucursales incluidas: el modo es del negocio, y una sucursal
 * puede ser un restaurante aunque su principal sea una tienda.
 *
 * Solo mueve el selector. El cliente lo lee del perfil (`GET /auth/profile`)
 * y decide qué ventana de POS abrir; las reglas de venta del backend no cambian.
 *
 * Transacción SERIALIZABLE: escritura de configuración sobre la fila de la
 * company; evita pisar cambios concurrentes.
 */
@Injectable()
export class UpdatePosModeAction {
  private readonly logger = new Logger(UpdatePosModeAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number, dto: UpdatePosModeDto): Promise<UpdatePosModeResult> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const companyRepo = manager.getRepository(Company);

      const company = await companyRepo.findOne({ where: { id: String(companyId) } });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} no existe.`);
      }

      company.pos_mode = dto.pos_mode;
      await companyRepo.save(company);

      this.logger.log({
        event: 'superadmin.pos_mode.updated',
        companyId,
        pos_mode: dto.pos_mode,
      });

      return { pos_mode: company.pos_mode };
    });
  }
}
