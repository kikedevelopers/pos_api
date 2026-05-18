import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GetCurrentCompanyAction } from './actions/get-current-company.action';
import { UpdateCompanyAction } from './actions/update-company.action';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { Company } from './entities/company.entity';

/**
 * Módulo `companies`.
 *
 * Expone:
 *   - `GET /companies`         → company autenticada (del JWT).
 *   - `PUT /companies/:id`     → update de la company autenticada.
 *
 * Exporta `TypeOrmModule` para que `AuthModule` siga pudiendo inyectar el
 * repo de `Company` durante `POST /auth/register`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Company])],
  controllers: [CompaniesController],
  providers: [CompaniesService, GetCurrentCompanyAction, UpdateCompanyAction],
  exports: [TypeOrmModule],
})
export class CompaniesModule {}
