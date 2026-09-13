import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

import type { UpdateElectronicBillingDto } from '../dto/update-electronic-billing.dto';

export interface UpdateElectronicBillingResult {
  electronicBillingEnabled: boolean;
}

/**
 * Activa/desactiva la Facturación Electrónica de un negocio desde el panel
 * superadmin (firmado). Setea `companies.electronic_billing_enabled`.
 *
 * Reglas:
 *   - El `companyId` debe ser el negocio PRINCIPAL (`is_branch=false`). La FE es
 *     identidad fiscal del negocio (NIT, resolución) y una sucursal la hereda
 *     del principal; se administra sobre el principal, no sobre la sucursal.
 *
 * El proceso de FE en sí (armado del payload, firma XAdES y envío a la DIAN) NO
 * vive aquí: lo ejecuta el API externo de Laravel (APIDIAN). Esta action solo
 * mueve el interruptor de habilitación.
 *
 * Transacción SERIALIZABLE: escritura de control de acceso; evita pisar cambios
 * concurrentes sobre la fila de la company.
 */
@Injectable()
export class UpdateElectronicBillingAction {
  private readonly logger = new Logger(UpdateElectronicBillingAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    companyId: number,
    dto: UpdateElectronicBillingDto,
  ): Promise<UpdateElectronicBillingResult> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const companyRepo = manager.getRepository(Company);

      const company = await companyRepo.findOne({ where: { id: String(companyId) } });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} no existe.`);
      }
      if (company.is_branch) {
        throw new BadRequestException(
          'La Facturación Electrónica se configura sobre el negocio principal, no sobre una sucursal.',
        );
      }

      company.electronic_billing_enabled = dto.enabled;
      await companyRepo.save(company);

      this.logger.log({
        event: 'superadmin.electronic_billing.updated',
        companyId,
        enabled: dto.enabled,
      });

      return { electronicBillingEnabled: company.electronic_billing_enabled };
    });
  }
}
