import { Module } from '@nestjs/common';

import { ElectronicBillingGuard } from '@/common/guards/electronic-billing.guard';

import { FeCatalogsController } from './fe-catalogs.controller';
import { FeCatalogsService } from './fe-catalogs.service';

/**
 * Proxy con caché de los catálogos de Facturación Electrónica de APIDIAN. No
 * tiene entidades propias: la fuente de la verdad es el API externo (regla del
 * proyecto: pos_api no duplica los catálogos de la DIAN).
 */
@Module({
  controllers: [FeCatalogsController],
  providers: [FeCatalogsService, ElectronicBillingGuard],
  exports: [FeCatalogsService],
})
export class FeCatalogsModule {}
