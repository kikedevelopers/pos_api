import { Module } from '@nestjs/common';

import { FinancialMovementsModule } from '@/modules/financial-movements/financial-movements.module';
import { RolesModule } from '@/modules/roles/roles.module';

import { LENDING_CUSTOMERS } from '../../ports/lending-customers.port';
import { LENDING_TENANT } from '../../ports/lending-tenant.port';
import { LENDING_TREASURY } from '../../ports/lending-treasury.port';
import { PosCustomersAdapter } from './pos-customers.adapter';
import { PosTenantAdapter } from './pos-tenant.adapter';
import { PosTreasuryAdapter } from './pos-treasury.adapter';

/**
 * ÚNICO punto de contacto entre préstamos y el POS: implementa los puertos de
 * préstamos (clientes, tesorería, tenant) con los módulos del POS y re-exporta
 * `RolesModule`, que necesita el `AdminLevelGuard` (permisos = núcleo
 * compartido).
 *
 * Para separar préstamos en su propia API, se reemplaza este módulo por uno
 * que implemente los mismos puertos contra la API del POS. Nada más cambia.
 */
@Module({
  imports: [FinancialMovementsModule, RolesModule],
  providers: [
    { provide: LENDING_CUSTOMERS, useClass: PosCustomersAdapter },
    { provide: LENDING_TREASURY, useClass: PosTreasuryAdapter },
    { provide: LENDING_TENANT, useClass: PosTenantAdapter },
  ],
  exports: [LENDING_CUSTOMERS, LENDING_TREASURY, LENDING_TENANT, RolesModule],
})
export class PosLendingIntegrationModule {}
