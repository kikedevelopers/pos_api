import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { bigintToNumber } from '@/modules/auth/internal/bigint-to-number';
import { CompanyMember } from '@/modules/companies/entities/company-member.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { toSubscriptionResponseDto } from '@/modules/subscriptions/dto/subscription-response.dto';
import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';
import { UsersService } from '@/modules/users/users.service';

import type { PortalAccountResponseDto } from '../dto/portal-account.dto';

/**
 * Lo que ve el dueño al entrar al portal: quién es, qué negocio tiene y en qué
 * va su suscripción.
 *
 * Se resuelve contra la company del JWT, no contra un id que venga del cliente.
 */
@Injectable()
export class GetPortalAccountAction {
  private readonly logger = new Logger(GetPortalAccountAction.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly subscriptionsService: SubscriptionsService,
    @InjectRepository(Company)
    private readonly companiesRepo: Repository<Company>,
    @InjectRepository(CompanyMember)
    private readonly membersRepo: Repository<CompanyMember>,
  ) {}

  async execute(userId: number, companyId: number): Promise<PortalAccountResponseDto> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const company = await this.companiesRepo.findOne({ where: { id: String(companyId) } });
    if (!company) {
      throw new NotFoundException('Negocio no encontrado');
    }

    // Sucursales adicionales: companies del dueño marcadas `is_branch`. Se
    // cuentan por membresía (no por `users.company_id`) porque una sucursal es
    // otra company de la que el dueño es miembro.
    const branchesCount = await this.membersRepo
      .createQueryBuilder('cm')
      .innerJoin('companies', 'c', 'c.id = cm.company_id')
      .where('cm.user_id = :userId', { userId: String(userId) })
      .andWhere('c.is_branch = true')
      .getCount();

    const subscription = await this.subscriptionsService.findApplicable(companyId);

    return {
      user: {
        id: bigintToNumber(user.id, this.logger, 'User'),
        name: user.name,
        lastname: user.lastname ?? '',
        email: user.email ?? '',
        created_at: user.created_at.toISOString(),
      },
      company: {
        id: bigintToNumber(company.id, this.logger, 'Company'),
        name: company.name,
        document_number: company.document_number ?? null,
        phone_number: company.phone_number ?? null,
        created_at: company.created_at.toISOString(),
        branches_count: branchesCount,
      },
      // `null` solo si la fila no existe (dato inconsistente): el portal lo
      // pinta como "no pudimos leer tu suscripción" en vez de reventar.
      subscription: subscription ? toSubscriptionResponseDto(subscription) : null,
    };
  }
}
