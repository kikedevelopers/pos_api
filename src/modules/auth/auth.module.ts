import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AlertConfigsModule } from '@/modules/alert-configs/alert-configs.module';
import { AppSettingsModule } from '@/modules/app-settings/app-settings.module';
import { CompaniesModule } from '@/modules/companies/companies.module';
import { EmployeesModule } from '@/modules/employees/employees.module';
import { SubscriptionsModule } from '@/modules/subscriptions/subscriptions.module';
import { TicketSettingsModule } from '@/modules/ticket-settings/ticket-settings.module';
import { UsersModule } from '@/modules/users/users.module';
import { WalletsModule } from '@/modules/wallets/wallets.module';

import { CheckEmailAction } from './actions/check-email.action';
import { GetMeAction } from './actions/get-me.action';
import { GetProfileAction } from './actions/get-profile.action';
import { LoginAction } from './actions/login.action';
import { RegisterAction } from './actions/register.action';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
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
  ],
  controllers: [AuthController],
  providers: [
    // Internals.
    DummyHashService,
    JwtIssuerService,
    // Actions.
    RegisterAction,
    LoginAction,
    GetMeAction,
    GetProfileAction,
    CheckEmailAction,
    // Facade.
    AuthService,
    // Passport.
    JwtStrategy,
  ],
  exports: [AuthService],
})
export class AuthModule {}
