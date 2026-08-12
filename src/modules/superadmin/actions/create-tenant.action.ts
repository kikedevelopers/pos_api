import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RegisterAction } from '@/modules/auth/actions/register.action';
import type { RegisterDto } from '@/modules/auth/dto/register.dto';
import { Subscription } from '@/modules/subscriptions/entities/subscription.entity';
import { User } from '@/modules/users/entities/user.entity';

import type { CreateTenantDto } from '../dto/create-tenant.dto';
import type { SuperadminCreateTenantResponseDto } from '../dto/superadmin-create-tenant-response.dto';

/**
 * Crea una cuenta nueva desde el panel kdevs-admin REUTILIZANDO el flujo de
 * registro cloud de placepos (`RegisterAction`). No reimplementa nada: la
 * cuenta nace idéntica a un registro normal — owner + company + membership +
 * seeds esenciales + suscripción trial de 10 días, todo atómico. Así queda
 * lista para iniciar sesión en placepos sin pasos extra.
 *
 * `from_offline_migration` se fuerza a `false`: una cuenta creada por el panel
 * es SIEMPRE un registro normal (10 días), nunca una migración offline.
 *
 * El `access_token` que devuelve `RegisterAction` se descarta: el panel no
 * inicia sesión por el owner; el owner se autentica luego desde su POS.
 */
@Injectable()
export class CreateTenantAction {
  private readonly logger = new Logger(CreateTenantAction.name);

  constructor(
    private readonly registerAction: RegisterAction,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Subscription)
    private readonly subscriptionRepo: Repository<Subscription>,
  ) {}

  async execute(dto: CreateTenantDto): Promise<SuperadminCreateTenantResponseDto> {
    const registerDto: RegisterDto = {
      name: dto.name,
      lastname: dto.lastname,
      email: dto.email,
      password: dto.password,
      company_name: dto.company_name,
      from_offline_migration: false,
    };

    // `skipActivation`: el operador ya validó al cliente; obligarlo a un correo
    // de ida y vuelta solo estorbaría. La cuenta nace activa y lista para entrar.
    const result = await this.registerAction.execute(registerDto, { skipActivation: true });
    const ownerId = Number(result.user.id);

    // `RegisterAction` ya creó company + owner + suscripción en su transacción.
    // Recuperamos companyId y vencimiento para el resumen que ve el panel
    // (lecturas livianas; la cuenta ya está completa e inalterada).
    const owner = await this.userRepo.findOne({ where: { id: String(ownerId) } });
    const companyId = owner ? Number(owner.company_id) : 0;
    const subscription = companyId
      ? await this.subscriptionRepo.findOne({ where: { company_id: String(companyId) } })
      : null;

    this.logger.log({
      event: 'superadmin.tenant.create',
      companyId,
      ownerId,
      ownerEmail: result.user.email,
      message: 'Cuenta creada desde el panel (registro cloud normal, trial 10 días).',
    });

    return {
      success: true,
      companyId,
      ownerId,
      companyName: dto.company_name,
      ownerEmail: result.user.email,
      subscriptionExpiresAt: subscription ? subscription.expires_at.toISOString() : '',
    };
  }
}
