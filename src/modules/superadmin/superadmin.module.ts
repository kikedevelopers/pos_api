import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/modules/auth/auth.module';
import { CompaniesModule } from '@/modules/companies/companies.module';
import { Company } from '@/modules/companies/entities/company.entity';
import { Subscription } from '@/modules/subscriptions/entities/subscription.entity';
import { User } from '@/modules/users/entities/user.entity';
import { UsersModule } from '@/modules/users/users.module';

import { CreateTenantAction } from './actions/create-tenant.action';
import { DeleteTenantAction } from './actions/delete-tenant.action';
import { ExportTenantAction } from './actions/export-tenant.action';
import { GetTenantDetailAction } from './actions/get-tenant-detail.action';
import { ImportTenantAction } from './actions/import-tenant.action';
import { ListTenantsAction } from './actions/list-tenants.action';
import { ResetTenantOwnerPasswordAction } from './actions/reset-tenant-owner-password.action';
import { UpdateBranchesAction } from './actions/update-branches.action';
import { UpdateSubscriptionAction } from './actions/update-subscription.action';
import { UpdateTenantCompanyAction } from './actions/update-tenant-company.action';
import { UpdateTenantOwnerAction } from './actions/update-tenant-owner.action';
import { SuperadminSignatureGuard } from './guards/superadmin-signature.guard';
import { SuperadminController } from './superadmin.controller';

/**
 * Módulo `superadmin`. Endpoints `/superadmin/*` consumidos por el panel
 * kdevs-admin, autenticados por firma asimétrica Ed25519 (par dedicado,
 * `SUPERADMIN_SIGNING_PUBLIC_KEY`) vía `SuperadminSignatureGuard`.
 *
 *   - Importa `UsersModule` por consistencia del grafo de dominio (owners).
 *   - Importa `AuthModule` para reutilizar `RegisterAction` en la creación de
 *     cuentas (`CreateTenantAction`): paridad total con el registro cloud de
 *     placepos. `AuthModule` no importa `SuperadminModule` (sin ciclo).
 *   - Importa `CompaniesModule` (exporta `UpdateCompanyAction`) y reutiliza
 *     `UpdateMeAction` (exportado por `UsersModule`) para la EDICIÓN de la
 *     company y del owner con paridad total (`PUT /companies/:id`,
 *     `PUT /users/me`). Sin ciclos: ninguno importa `SuperadminModule`.
 *   - `TypeOrmModule.forFeature([Company, User, Subscription])` da los repos a
 *     las actions de listado/detalle/suscripción/borrado. `ListTenantsAction`
 *     usa el repo de `User` y un LEFT JOIN manual a `subscriptions`.
 */
@Module({
  imports: [
    UsersModule,
    AuthModule,
    CompaniesModule,
    TypeOrmModule.forFeature([Company, User, Subscription]),
  ],
  controllers: [SuperadminController],
  providers: [
    SuperadminSignatureGuard,
    ListTenantsAction,
    GetTenantDetailAction,
    UpdateSubscriptionAction,
    UpdateBranchesAction,
    DeleteTenantAction,
    CreateTenantAction,
    UpdateTenantOwnerAction,
    ResetTenantOwnerPasswordAction,
    UpdateTenantCompanyAction,
    ExportTenantAction,
    ImportTenantAction,
  ],
})
export class SuperadminModule {}
