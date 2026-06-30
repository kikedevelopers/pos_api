import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository } from 'typeorm';

import { CompanyMember } from '@/modules/companies/entities/company-member.entity';
import { Company } from '@/modules/companies/entities/company.entity';

import type { CompanyProfileItemDto } from '../dto/auth-response.dto';
import { companyToCompanyProfileItemDto } from '../internal/auth-mappers';

/**
 * Lista las companies (negocio principal + sucursales) de las que el owner es
 * miembro. Fuente: `company_members` por `user_id`. Devuelve el mismo shape
 * `CompanyProfileItemDto` que `GET /auth/profile`, con `is_branch` real.
 */
@Injectable()
export class ListBranchesAction {
  private readonly logger = new Logger(ListBranchesAction.name);

  constructor(
    @InjectRepository(CompanyMember)
    private readonly membersRepo: Repository<CompanyMember>,
    @InjectRepository(Company)
    private readonly companiesRepo: Repository<Company>,
  ) {}

  async execute(userId: number): Promise<CompanyProfileItemDto[]> {
    const members = await this.membersRepo.find({
      where: { user_id: String(userId) },
      order: { company_id: 'ASC' },
    });
    if (members.length === 0) {
      return [];
    }

    const companyIds = members.map((m) => m.company_id);
    const companies = await this.companiesRepo.find({ where: { id: In(companyIds) } });

    // Estado activa/suspendida por company (multi-sucursal gating).
    const activeById = new Map(members.map((m) => [m.company_id, m.is_active]));

    // Negocio principal (is_branch=false) primero, luego sucursales por id.
    return companies
      .map((c) => companyToCompanyProfileItemDto(c, this.logger, activeById.get(c.id) ?? true))
      .sort((a, b) => {
        if (a.is_branch !== b.is_branch) {
          return a.is_branch ? 1 : -1;
        }
        return a.id - b.id;
      });
  }
}
