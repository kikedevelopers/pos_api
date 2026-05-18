import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { CarrierPaymentsService } from './carrier-payments.service';
import {
  CarrierPaymentResponseDto,
  toCarrierPaymentResponseDto,
} from './dto/carrier-payment-response.dto';
import { CreateCarrierPaymentDto } from './dto/create-carrier-payment.dto';
import { ListCarrierPaymentsQueryDto } from './dto/list-carrier-payments-query.dto';

/**
 * Endpoints `/carrier-payments`. Espejo del contrato PlacePos.
 *
 * Autorización:
 *   - GET: 3 roles (owner/manager/employee).
 *   - POST: owner/manager. Más restrictivo que PlacePos (que permite
 *     employee también) por defensa — solo personal con autoridad
 *     contable registra pagos a transportistas.
 */
@ApiTags('carrier-payments')
@ApiBearerAuth('bearer')
@Controller('carrier-payments')
@Roles('owner', 'manager', 'employee')
export class CarrierPaymentsController {
  constructor(private readonly carrierPaymentsService: CarrierPaymentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Registrar abono a transportista' })
  @ApiBody({ type: CreateCarrierPaymentDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: CarrierPaymentResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Crédito, carrier, banco, billetera o caja no encontrada',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Regla de negocio rechazada (monto excede, saldo insuficiente, método inválido)',
  })
  async create(
    @Body() dto: CreateCarrierPaymentDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<CarrierPaymentResponseDto> {
    const payment = await this.carrierPaymentsService.process(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });

    // Re-cargamos con joins para construir el response. Coste mínimo —
    // mantiene la simetría con el listado.
    const items = await this.carrierPaymentsService.list(companyId, {});
    const created = items.find((it) => Number(it.payment.id) === Number(payment.id));
    if (!created) {
      // Fallback defensivo: el INSERT ya commiteó; respondemos con los datos
      // que tenemos aunque sin join.
      return toCarrierPaymentResponseDto(payment, {
        carrier_id: null,
        purchase_id: null,
        purchase_number: null,
      });
    }
    return toCarrierPaymentResponseDto(created.payment, {
      carrier_id: created.carrier_id,
      purchase_id: created.purchase_id,
      purchase_number: created.purchase_number,
    });
  }

  @Get()
  @ApiOperation({
    summary: 'Listar pagos a transportistas (filtros opcionales)',
    description: 'Filtros: carrier_id, from, to (YYYY-MM-DD). Sin paginación.',
  })
  @ApiQuery({ name: 'carrier_id', type: 'integer', required: false })
  @ApiQuery({ name: 'from', type: 'string', required: false, example: '2026-05-01' })
  @ApiQuery({ name: 'to', type: 'string', required: false, example: '2026-05-31' })
  @ApiResponse({ status: HttpStatus.OK, type: [CarrierPaymentResponseDto] })
  async list(
    @Query() query: ListCarrierPaymentsQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<CarrierPaymentResponseDto[]> {
    const items = await this.carrierPaymentsService.list(companyId, query);
    return items.map((it) =>
      toCarrierPaymentResponseDto(it.payment, {
        carrier_id: it.carrier_id,
        purchase_id: it.purchase_id,
        purchase_number: it.purchase_number,
      }),
    );
  }
}
