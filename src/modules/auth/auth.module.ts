import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AlertConfigsModule } from '@/modules/alert-configs/alert-configs.module';
import { AppSettingsModule } from '@/modules/app-settings/app-settings.module';
import { CompaniesModule } from '@/modules/companies/companies.module';
import { EmployeesModule } from '@/modules/employees/employees.module';
import { ProductsModule } from '@/modules/products/products.module';
import { RolesModule } from '@/modules/roles/roles.module';
import { SubscriptionsModule } from '@/modules/subscriptions/subscriptions.module';
import { TicketSettingsModule } from '@/modules/ticket-settings/ticket-settings.module';
import { UsersModule } from '@/modules/users/users.module';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { CheckEmailAction } from './actions/check-email.action';
import { CreateBranchAction } from './actions/create-branch.action';
import { GetMeAction } from './actions/get-me.action';
import { GetProfileAction } from './actions/get-profile.action';
import { ListBranchesAction } from './actions/list-branches.action';
import { ActivateAccountAction } from './actions/activate-account.action';
import { IssueActivationTokenAction } from './actions/issue-activation-token.action';
import { LoginAction } from './actions/login.action';
import { RegisterAction } from './actions/register.action';
import { SeedCompanyAction } from './actions/seed-company.action';
import { SetActiveBranchesAction } from './actions/set-active-branches.action';
import { SwitchBranchAction } from './actions/switch-branch.action';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BranchesController } from './branches.controller';
import { DummyHashService } from './internal/dummy-hash.service';
import { JwtIssuerService } from './internal/jwt-issuer.service';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Módulo `auth`. Cablea:
 *   - `PassportModule`  con estrategia por defecto `jwt`.
 *   - `JwtModule`       con secret de env y sin `expiresIn` por defecto (el
 *                       `JwtIssuerService` lo decide por tipo de usuario al
 *                       firmar).
 *   - `JwtStrategy`     como provider (se ejecuta al verificar tokens).
 *   - Internals:        `DummyHashService` (anti-timing) y `JwtIssuerService`.
 *   - Actions:          `Register`, `Login`, `GetMe`, `GetProfile`.
 *   - `AuthService`     y `AuthController`.
 *
 * Exporta `AuthService` por si un módulo futuro lo necesita (no debería —
 * preferir endpoints HTTP entre módulos).
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
    UsersModule,
    CompaniesModule,
    EmployeesModule,
    // Seeds esenciales para POST /auth/register — todos invocados dentro de
    // la transacción que crea Company + User.
    WalletsModule,
    TicketSettingsModule,
    AppSettingsModule,
    AlertConfigsModule,
    // Suscripción (cloud-only): seed en el registro (CreateSubscriptionAction)
    // y bloqueo de login (SubscriptionsService). SubscriptionsModule NO importa
    // AuthModule, así que no hay ciclo.
    SubscriptionsModule,
    // FASE 1 (CLONAR): expone CloneProductsToBranchAction para el endpoint
    // POST /branches/:id/clone-products. ProductsModule no importa AuthModule
    // (sin ciclo).
    ProductsModule,
    // FASE 2 (ROLES): expone RolesService para resolver los permisos efectivos
    // del usuario en GET /auth/profile. RolesModule no importa AuthModule.
    RolesModule,
  ],
  controllers: [AuthController, BranchesController],
  providers: [
    // Internals.
    DummyHashService,
    JwtIssuerService,
    // Actions.
    RegisterAction,
    LoginAction,
    ActivateAccountAction,
    IssueActivationTokenAction,
    GetMeAction,
    GetProfileAction,
    CheckEmailAction,
    // Multi-sucursal: seed compartido + endpoints de branches.
    SeedCompanyAction,
    CreateBranchAction,
    ListBranchesAction,
    SwitchBranchAction,
    SetActiveBranchesAction,
    // Facade.
    AuthService,
    // Passport.
    JwtStrategy,
  ],
  // `RegisterAction` se exporta para que `SuperadminModule` cree cuentas desde
  // el panel kdevs-admin REUTILIZANDO exactamente el flujo de registro cloud
  // (paridad total con placepos). `AuthModule` no importa `SuperadminModule`,
  // así que no hay ciclo.
  // `IssueActivationTokenAction` se exporta para el reenvío del enlace desde el
  // panel superadmin: reemitir es exactamente lo mismo que hace el registro, y
  // duplicar esa lógica sería la forma de que las dos se desincronizaran.
  exports: [AuthService, RegisterAction, IssueActivationTokenAction],
})
export class AuthModule {}
