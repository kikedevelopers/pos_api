import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { RealtimeGateway } from './realtime.gateway';
import { RealtimeInvalidationInterceptor } from './realtime-invalidation.interceptor';

/**
 * Módulo de tiempo real (Socket.IO).
 *
 * Registra `JwtModule` con el MISMO `JWT_SECRET` que la auth HTTP para que el
 * gateway verifique los tokens del handshake con idéntico secret/algoritmo.
 *
 * Exporta `RealtimeGateway` para inyectarlo donde se disparan los eventos
 * (p.ej. `SalesModule` al crear una venta). El gateway es ZERO-dependencia de
 * dominio: solo recibe `companyId`/`sellerId`/payload y emite.
 *
 * Registra GLOBALMENTE (`APP_INTERCEPTOR`) el `RealtimeInvalidationInterceptor`,
 * que emite `dashboard:changed` tras CUALQUIER mutación HTTP exitosa con tenant.
 * Como este módulo ya se importa en `AppModule`, basta declararlo aquí para que
 * el interceptor aplique a toda la app (un solo punto de invalidación).
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [
    RealtimeGateway,
    {
      provide: APP_INTERCEPTOR,
      useClass: RealtimeInvalidationInterceptor,
    },
  ],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
