import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/modules/auth/auth.module';
import { CompanyMember } from '@/modules/companies/entities/company-member.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { Subscription } from '@/modules/subscriptions/entities/subscription.entity';
import { SubscriptionsModule } from '@/modules/subscriptions/subscriptions.module';
import { UsersModule } from '@/modules/users/users.module';

import { ChangePlanAction } from './actions/change-plan.action';
import { GetPortalAccountAction } from './actions/get-portal-account.action';
import { PortalLoginAction } from './actions/portal-login.action';
import { PortalController } from './portal.controller';

/**
 * Módulo `portal` (cloud-only): el portal de facturación de la landing.
 *
 * Reutiliza a propósito las piezas del login de la app (`JwtIssuerService`,
 * `DummyHashService`, `UsersService`) en vez de tener su propia verificación de
 * credenciales: dos implementaciones de "¿esta contraseña es correcta?" se
 * desincronizan, y la que se olvida de un chequeo es la que abre la puerta.
 *
 * `AuthModule` no importa este módulo → sin ciclo.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, Company, CompanyMember]),
    AuthModule,
    UsersModule,
    SubscriptionsModule,
  ],
  controllers: [PortalController],
  providers: [PortalLoginAction, GetPortalAccountAction, ChangePlanAction],
})
export class PortalModule {}
