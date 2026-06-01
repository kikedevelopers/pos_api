import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import { Subscription } from '@/modules/subscriptions/entities/subscription.entity';
import { User } from '@/modules/users/entities/user.entity';
import { UsersModule } from '@/modules/users/users.module';

import { DeleteTenantAction } from './actions/delete-tenant.action';
import { GetTenantDetailAction } from './actions/get-tenant-detail.action';
import { ListTenantsAction } from './actions/list-tenants.action';
import { UpdateSubscriptionAction } from './actions/update-subscription.action';
import { SuperadminSignatureGuard } from './guards/superadmin-signature.guard';
import { SuperadminController } from './superadmin.controller';

/**
 * Módulo `superadmin`. Endpoints `/superadmin/*` consumidos por el panel
 * kdevs-admin, autenticados por firma asimétrica Ed25519 (par dedicado,
 * `SUPERADMIN_SIGNING_PUBLIC_KEY`) vía `SuperadminSignatureGuard`.
 *
 *   - Importa `UsersModule` por consistencia del grafo de dominio (owners).
 *   - `TypeOrmModule.forFeature([Company, User, Subscription])` da los repos a
 *     las actions de listado/detalle/suscripción/borrado. `ListTenantsAction`
 *     usa el repo de `User` y un LEFT JOIN manual a `subscriptions`.
 */
@Module({
  imports: [UsersModule, TypeOrmModule.forFeature([Company, User, Subscription])],
  controllers: [SuperadminController],
  providers: [
    SuperadminSignatureGuard,
    ListTenantsAction,
    GetTenantDetailAction,
    UpdateSubscriptionAction,
    DeleteTenantAction,
  ],
})
export class SuperadminModule {}
