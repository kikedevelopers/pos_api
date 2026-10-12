import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

import type { UpdateAiAccessDto } from '../dto/update-ai-access.dto';

export interface UpdateAiAccessResult {
  aiEnabled: boolean;
}

/**
 * Activa/desactiva el acceso al asistente **Place** (IA) de una cuenta desde el
 * panel superadmin (firmado). Setea `companies.ai_enabled`.
 *
 * Se aplica sobre la company indicada (principal o sucursal): el acceso es por
 * negocio y todos sus usuarios lo comparten. Con el flag apagado, pos_api
 * rechaza `/ai/chat` (403 AI_NOT_ENABLED) y reporta `enabled:false`.
 *
 * Transacción SERIALIZABLE: es una escritura de control de acceso; evita pisar
 * cambios concurrentes sobre la fila de la company.
 */
@Injectable()
export class UpdateAiAccessAction {
  private readonly logger = new Logger(UpdateAiAccessAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number, dto: UpdateAiAccessDto): Promise<UpdateAiAccessResult> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const companyRepo = manager.getRepository(Company);

      const company = await companyRepo.findOne({ where: { id: String(companyId) } });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} no existe.`);
      }

      company.ai_enabled = dto.enabled;
      await companyRepo.save(company);

      this.logger.log({
        event: 'superadmin.ai_access.updated',
        companyId,
        enabled: dto.enabled,
      });

      return { aiEnabled: company.ai_enabled };
    });
  }
}
