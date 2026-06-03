import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { RealtimeGateway } from './realtime.gateway';

/**
 * Módulo de tiempo real (Socket.IO).
 *
 * Registra `JwtModule` con el MISMO `JWT_SECRET` que la auth HTTP para que el
 * gateway verifique los tokens del handshake con idéntico secret/algoritmo.
 *
 * Exporta `RealtimeGateway` para inyectarlo donde se disparan los eventos
 * (p.ej. `SalesModule` al crear una venta). El gateway es ZERO-dependencia de
 * dominio: solo recibe `companyId`/`sellerId`/payload y emite.
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
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
