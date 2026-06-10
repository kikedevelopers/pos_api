import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { CompanyMember } from '@/modules/companies/entities/company-member.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { UsersService } from '@/modules/users/users.service';

import { JwtIssuerService } from '../internal/jwt-issuer.service';

/**
 * Cambia la sucursal activa del owner: valida que sea MIEMBRO de la company
 * destino y re-emite un JWT con ese `company_id`. El cliente reemplaza su token
 * y recarga; a partir de ahí todo el scoping por `company_id` apunta a la nueva
 * sucursal.
 *
 * Anti-IDOR: el `companyId` de la URL NUNCA se confía; debe existir en
 * `company_members` para este `user_id`. Si no, 403 (no se filtra si la company
 * existe o no).
 */
@Injectable()
export class SwitchBranchAction {
  private readonly logger = new Logger(SwitchBranchAction.name);

  constructor(
    @InjectRepository(CompanyMember)
    private readonly membersRepo: Repository<CompanyMember>,
    @InjectRepository(Company)
    private readonly companiesRepo: Repository<Company>,
    private readonly usersService: UsersService,
    private readonly jwtIssuer: JwtIssuerService,
  ) {}

  async execute(userId: number, targetCompanyId: number): Promise<{ access_token: string }> {
    const membership = await this.membersRepo.findOne({
      where: { user_id: String(userId), company_id: String(targetCompanyId) },
    });
    if (!membership) {
      throw new ForbiddenException('No tienes acceso a esa sucursal');
    }

    const company = await this.companiesRepo.findOne({
      where: { id: String(targetCompanyId) },
    });
    if (!company) {
      throw new NotFoundException('Empresa no encontrada');
    }

    // Datos frescos del owner para los claims (name/lastname/type). findById no
    // filtra por company (cuenta única del owner).
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    // [SEGURIDAD] El switch al negocio principal SIEMPRE se permite (es el
    // fallback al inhabilitar/suspender). A una SUCURSAL solo si la cuenta
    // tiene sucursales habilitadas y esa membresía está activa.
    if (company.is_branch) {
      if (!user.branches_enabled) {
        throw new ForbiddenException('Las sucursales no están habilitadas para esta cuenta.');
      }
      if (!membership.is_active) {
        throw new ForbiddenException('Esa sucursal está suspendida.');
      }
    }

    const access_token = await this.jwtIssuer.sign({
      userId: user.id,
      companyId: String(targetCompanyId),
      name: user.name,
      lastname: user.lastname,
      type: user.type,
      account: 'user',
    });

    this.logger.log({
      event: 'branch.switched',
      userId,
      companyId: targetCompanyId,
    });

    return { access_token };
  }
}
