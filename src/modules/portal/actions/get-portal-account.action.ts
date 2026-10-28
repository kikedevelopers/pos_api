import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, type Repository } from 'typeorm';

import { bigintToNumber } from '@/modules/auth/internal/bigint-to-number';
import {
  SubscriptionPayment,
  SubscriptionPaymentStatus,
} from '@/modules/billing/entities/subscription-payment.entity';
import { CompanyMember } from '@/modules/companies/entities/company-member.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { toSubscriptionResponseDto } from '@/modules/subscriptions/dto/subscription-response.dto';
import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';
import { UsersService } from '@/modules/users/users.service';

import type { PortalAccountResponseDto, PortalUpcomingPeriodDto } from '../dto/portal-account.dto';

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
    @InjectRepository(SubscriptionPayment)
    private readonly paymentsRepo: Repository<SubscriptionPayment>,
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
    const now = new Date();
    const upcoming = subscription
      ? await this.paymentsRepo.findOne({
          where: {
            subscription_id: subscription.id,
            status: SubscriptionPaymentStatus.APPROVED,
            period_starts_at: MoreThan(now),
          },
          order: { period_starts_at: 'ASC' },
        })
      : null;

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
      subscription: subscription ? toSubscriptionResponseDto(subscription, now) : null,
      upcoming_period: toUpcomingPeriod(upcoming),
    };
  }
}

function toUpcomingPeriod(payment: SubscriptionPayment | null): PortalUpcomingPeriodDto | null {
  if (!payment?.period_starts_at || !payment.period_ends_at) {
    return null;
  }
  return {
    plan: payment.plan,
    starts_at: payment.period_starts_at.toISOString(),
    ends_at: payment.period_ends_at.toISOString(),
  };
}
