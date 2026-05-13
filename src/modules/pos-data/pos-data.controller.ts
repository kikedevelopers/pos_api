import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import {
  PosDataService,
  type PosCustomer,
  type PosDataDestinationsPayload,
  type PosItem,
  type PosPaymentBank,
  type TransferCashResult,
} from './pos-data.service';
import { TransferCashDto } from './dto/transfer-cash.dto';

/**
 * Endpoints `/pos-data` — Fase 11.4. Espejo PlacePos byte-por-byte
 * (`pos-data.routes.ts`).
 *
 * Roles: cualquier autenticado (owner|manager|employee). El POS es la
 * pantalla operativa diaria; restringir los listados básicos (items,
 * customers, payment-banks) impediría a los `employee` operar. Para
 * `transfer-cash` se mantiene la apertura porque el cajero también podría
 * necesitar mover dinero entre caja y wallet/bank durante el turno.
 */
@ApiTags('pos-data')
@ApiBearerAuth('bearer')
@Controller('pos-data')
export class PosDataController {
  constructor(private readonly posDataService: PosDataService) {}

  @Get('items')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listado de items vendibles en POS con prices, packaging y stock.' })
  @ApiResponse({ status: HttpStatus.OK })
  items(@CurrentCompany() companyId: number): Promise<PosItem[]> {
    return this.posDataService.items(companyId);
  }

  @Get('customers')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listado plano de customers para typeahead del POS.' })
  @ApiResponse({ status: HttpStatus.OK })
  customers(@CurrentCompany() companyId: number): Promise<PosCustomer[]> {
    return this.posDataService.customers(companyId);
  }

  @Get('payment-banks')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Bancos habilitados para cobrar en POS (available_in_pos=true).' })
  @ApiResponse({ status: HttpStatus.OK })
  paymentBanks(@CurrentCompany() companyId: number): Promise<PosPaymentBank[]> {
    return this.posDataService.paymentBanks(companyId);
  }

  @Get('transfer-destinations')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Cuentas destino para mover efectivo desde la caja del POS. Agrupado { users, wallets, banks }.',
    description:
      'Cloud divergence: `users` siempre vacío — el modelo de caja en cloud es por turno de company, no por usuario.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  transferDestinations(@CurrentCompany() companyId: number): Promise<PosDataDestinationsPayload> {
    return this.posDataService.transferDestinations(companyId);
  }

  @Post('transfer-cash')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Mueve efectivo desde la caja abierta del POS a un wallet o bank.',
    description:
      'En UNA transacción: lockea el turno, valida saldo, inserta log OUT, acredita destino y registra FinancialMovement TRANSFER. `destinationType: "user"` se rechaza con 422 UNSUPPORTED_DESTINATION (cloud no tiene caja personal por usuario).',
  })
  @ApiBody({ type: TransferCashDto })
  @ApiResponse({ status: HttpStatus.OK, description: '{ message }' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No hay caja abierta / destino no encontrado',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Saldo insuficiente / destino user no soportado / monto inválido',
  })
  transferCash(
    @Body() dto: TransferCashDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<TransferCashResult> {
    return this.posDataService.doTransferCash(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
  }
}
