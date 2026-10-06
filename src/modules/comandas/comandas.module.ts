import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';

import { FindActiveOrdersAction } from './actions/find-active-orders.action';
import { ComandasController } from './comandas.controller';
import { ComandasService } from './comandas.service';

/**
 * Módulo `comandas` — lista de pedidos ORDER activos para cocina/meseros (modo
 * restaurante). Solo lectura: reusa las entidades `SaleInvoice` y
 * `SaleInvoiceLine`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SaleInvoice, SaleInvoiceLine])],
  controllers: [ComandasController],
  providers: [ComandasService, FindActiveOrdersAction],
  exports: [ComandasService],
})
export class ComandasModule {}
