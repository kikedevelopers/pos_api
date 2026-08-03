import { Injectable, Logger } from '@nestjs/common';

import { UpdateCompanyAction } from '@/modules/companies/actions/update-company.action';
import type { UpdateCompanyDto } from '@/modules/companies/dto/update-company.dto';

import type { SuperadminTenantCompanyDto } from '../dto/superadmin-tenant-detail.dto';

/**
 * Edita los datos de la company de un tenant desde el panel superadmin
 * (firmado). REUTILIZA `UpdateCompanyAction` — la misma lógica de
 * `PUT /companies/:id` de placepos: update parcial y normalización de cadenas
 * vacías a `null` en document_number/address/email/phone_number. Paridad total.
 *
 * Proyecta la entidad al mismo shape que el detalle (`SuperadminTenantCompanyDto`)
 * para que el panel refresque la vista sin re-consultar.
 */
@Injectable()
export class UpdateTenantCompanyAction {
  private readonly logger = new Logger(UpdateTenantCompanyAction.name);

  constructor(private readonly updateCompanyAction: UpdateCompanyAction) {}

  async execute(companyId: number, dto: UpdateCompanyDto): Promise<SuperadminTenantCompanyDto> {
    const company = await this.updateCompanyAction.execute(companyId, dto);

    this.logger.log({ event: 'superadmin.company.updated', companyId });

    return {
      id: Number(company.id),
      name: company.name,
      documentNumber: company.document_number,
      address: company.address,
      email: company.email,
      phoneNumber: company.phone_number,
      origin: company.origin,
      createdAt: company.created_at.toISOString(),
      isBranch: company.is_branch,
    };
  }
}
