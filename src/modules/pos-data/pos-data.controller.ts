import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import {
  PosDataService,
  type CashSummaryResult,
  type CloseCashResult,
  type PosCustomer,
  type PosDataDestinationsPayload,
  type PosItem,
  type PosPaymentBank,
  type TransferCashResult,
} from './pos-data.service';
import { CloseCashDto } from './dto/close-cash.dto';
import { TransferCashDto } from './dto/transfer-cash.dto';

/**
 * Endpoints `/pos-data` — Fase 11.4. Espejo PlacePos byte-por-byte
 * (`pos-data.routes.ts`).
 *
 * Roles: cualquier autenticado (owner|manager|employee). El POS es la
 * pantalla operativa diaria; restringir los listados básicos (items,
 * customers, payment-banks) impediría a los `employee` operar. Para
 * `transfer-cash` y `close-cash` se mantiene la apertura porque el cajero
 * también necesita mover dinero / cerrar SU propia caja al final del día.
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

  @Get('cash-summary')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Resumen del estado actual de la caja del actor: balance, base_amount, available_to_move.',
    description:
      'SELECT puro sobre `cash_registers` para `(company_id, user_id)`. Si la caja no existe todavía, devuelve los tres campos en 0.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: '{ balance, base_amount, available_to_move }',
  })
  cashSummary(
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CashSummaryResult> {
    return this.posDataService.cashSummary(companyId, currentUser.user_id);
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

  @Post('close-cash')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Cierre de caja del actor con dos modos: simple o conciliación.',
    description:
      'Modo simple (reconcile=false): traslada `amount_to_transfer` al destino. Modo conciliación (reconcile=true): exige `counted_amount`, deja la caja en `base_amount`, marca sobrante/faltante y traslada el excedente. Todo en una sola transacción. `destinationType: "user"` se rechaza con 422 UNSUPPORTED_DESTINATION. Header `Idempotency-Key` opcional (UUID v4): si llega y ya hubo un cierre con esa key, se devuelve el resultado anterior sin re-cobrar.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'UUID v4 opcional. Si llega, un reintento (por timeout de red) NO duplica el cierre — devuelve el resultado previo. Si no llega, comportamiento estándar.',
  })
  @ApiBody({ type: CloseCashDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: '{ message, moved_amount, difference, new_balance }',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Idempotency-Key con formato inválido (no es UUID v4)',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Destino (wallet|bank) no encontrado',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'Errores de negocio: NOTHING_TO_REGISTER, INSUFFICIENT_BALANCE, COUNTED_BELOW_BASE, DESTINATION_REQUIRED, UNSUPPORTED_DESTINATION',
  })
  closeCash(
    @Body() dto: CloseCashDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CloseCashResult> {
    const normalizedKey = this.validateIdempotencyKey(idempotencyKey);
    return this.posDataService.doCloseCash(
      dto,
      companyId,
      {
        id: currentUser.user_id,
        fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      },
      normalizedKey,
    );
  }

  /**
   * Valida el header `Idempotency-Key` cuando llega. Acepta UUID v4 estricto
   * (mismo formato que los `uuid` de pagos del API). Si llega vacío o ausente
   * devolvemos `null` para que el flow siga sin idempotencia. Si llega con
   * formato malo, 400 — preferible a aceptar silenciosamente y re-cobrar.
   */
  private validateIdempotencyKey(raw: string | undefined): string | null {
    if (!raw) {
      return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    // UUID v4: 8-4-4-4-12, tercer grupo empieza con '4', cuarto con [89ab].
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!v4.test(trimmed)) {
      throw new BadRequestException({
        message: 'Idempotency-Key inválido: debe ser un UUID v4',
        payload: { code: 'INVALID_IDEMPOTENCY_KEY' },
      });
    }
    return trimmed.toLowerCase();
  }
}
