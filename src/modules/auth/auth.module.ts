import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { CompaniesModule } from '@/modules/companies/companies.module';
import { EmployeesModule } from '@/modules/employees/employees.module';
import { UsersModule } from '@/modules/users/users.module';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Módulo `auth`. Cablea:
 *   - `PassportModule`  con estrategia por defecto `jwt`.
 *   - `JwtModule`       con secret de env y sin `expiresIn` por defecto (el
 *                       service lo decide por tipo de usuario al firmar).
 *   - `JwtStrategy`     como provider (se ejecuta al verificar tokens).
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
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
