import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GetCurrentCompanyAction } from './actions/get-current-company.action';
import { ListAllCompaniesAction } from './actions/list-all-companies.action';
import { UpdateCompanyAction } from './actions/update-company.action';
import { AdminCompaniesController } from './admin-companies.controller';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { CompanyMember } from './entities/company-member.entity';
import { Company } from './entities/company.entity';

/**
 * Módulo `companies`.
 *
 * Expone:
 *   - `GET /companies`            → company autenticada (del JWT).
 *   - `PUT /companies/:id`        → update de la company autenticada.
 *   - `GET /admin/companies`      → lista cross-tenant (solo superadmin).
 *
 * Exporta `TypeOrmModule` para que `AuthModule` siga pudiendo inyectar el
 * repo de `Company` durante `POST /auth/register`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Company, CompanyMember])],
  controllers: [CompaniesController, AdminCompaniesController],
  providers: [
    CompaniesService,
    GetCurrentCompanyAction,
    UpdateCompanyAction,
    ListAllCompaniesAction,
  ],
  // `UpdateCompanyAction` se exporta para que `SuperadminModule` reutilice la
  // edición de la company (paridad con `PUT /companies/:id`) sin duplicar la
  // normalización (vacío→null) ni el manejo de campos.
  exports: [TypeOrmModule, UpdateCompanyAction],
})
export class CompaniesModule {}
