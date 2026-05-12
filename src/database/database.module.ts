import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'node:path';
import type { DatabaseConfig } from '@/config/configuration';

/**
 * Módulo de base de datos.
 * Configura TypeORM de forma asíncrona usando `ConfigService`.
 * Sin `synchronize: true` — todos los cambios de esquema vía migraciones.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const db = configService.getOrThrow<DatabaseConfig>('database');
        return {
          type: 'postgres',
          host: db.host,
          port: db.port,
          username: db.username,
          password: db.password,
          database: db.database,
          synchronize: db.synchronize,
          logging: db.logging,
          ssl: db.ssl ? { rejectUnauthorized: false } : false,
          autoLoadEntities: true,
          entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
          migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
          migrationsTableName: 'migrations',
          migrationsRun: false,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
