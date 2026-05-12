import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { ListPaymentsResponseDto } from './dto/payment-response.dto';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';
import { PaymentsService } from './payments.service';

/**
 * Endpoints `/payments` — Fase 9. Agregador read-only que consolida
 * `sale_payments` + `purchase_payments` en una sola vista paginable.
 *
 * **Divergencia documentada respecto a PlacePos**: en PlacePos local,
 * `/payments` es POST que recibe un payload de `processPayment` (procesa un
 * pago en POS). El cloud asume ese mismo path con semántica DIFERENTE: GET
 * agregador para dashboard y conciliación. Cuando se implemente la Fase 10,
 * el POST de procesamiento de pago vivirá bajo `/sales/:id/payments` y
 * `/purchases/:id/payments` (ya existentes en este API).
 *
 * Roles: `owner`, `manager` solamente.
 */
@ApiTags('payments')
@ApiBearerAuth('bearer')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  @Roles('owner', 'manager')
  @ApiOperation({
    summary:
      'Listar todos los pagos (ventas + compras) de la company. Filtrable por type, customer, supplier, rango de fechas.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: ListPaymentsResponseDto })
  async listAll(
    @Query() query: ListPaymentsQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<ListPaymentsResponseDto> {
    return this.paymentsService.listAll(companyId, query);
  }
}
