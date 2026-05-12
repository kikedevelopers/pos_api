import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Company } from './entities/company.entity';

/**
 * Módulo `companies` — esqueleto.
 *
 * TODO(Fase futura del dominio `companies`): añadir `CompaniesService`,
 * `CompaniesController` y los endpoints `GET /companies` y `PUT /companies`
 * espejados del PlacePos cuando llegue el módulo en su fase.
 *
 * Por ahora exporta solo el repo de `Company` para que `AuthModule` pueda
 * inyectarlo y crear la company durante `POST /auth/register`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Company])],
  exports: [TypeOrmModule],
})
export class CompaniesModule {}
