import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import type { ProcessPaymentResult } from './actions/process-payment.action';
import { ProcessPaymentDto } from './dto/process-payment.dto';
import { PaymentsService } from './payments.service';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Endpoint `POST /payments` — espejo de PlacePos
 * (`placepos/src/main/server/routes/payments.routes.ts`).
 *
 * --------------------------------------------------------------------------
 * Contrato HTTP
 * --------------------------------------------------------------------------
 *
 *   - 201 → `{ success: true, payload: ProcessPaymentResult }` cuando el
 *     pago se procesó correctamente.
 *   - 422 → `{ success: false, error: result.message, payload: { code } }`
 *     cuando hay un fallo de regla de negocio (factura no encontrada,
 *     mismatch de montos, crédito sin cliente, margen bajo, etc.).
 *
 * Cualquier excepción inesperada cae en el `AllExceptionsFilter` (500).
 *
 * --------------------------------------------------------------------------
 * Roles
 * --------------------------------------------------------------------------
 *
 * `owner`, `manager`, `employee` — un cajero (employee) puede procesar pagos
 * de ventas que él mismo o un compañero abrió. Multi-tenancy se enforce vía
 * `@CurrentCompany()` desde el JWT — el `company_id` jamás viene del payload.
 */
@ApiTags('payments')
@ApiBearerAuth('bearer')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Procesa un pago de un pedido (ORDER → SALE). Genera folio SALE, descuenta stock, registra SalePayment + SaleCredit + side effects de caja/banco. Acepta header opcional Idempotency-Key (UUID v4) para deduplicar reintentos.',
  })
  @ApiBody({ type: ProcessPaymentDto })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'UUID v4 opcional. Si llega, dos requests idénticas devuelven el mismo SalePayment sin duplicar cobro.',
    required: false,
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Pago procesado. Payload `ProcessPaymentResult`.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Payload inválido (validation pipe) o Idempotency-Key con formato no UUID v4.',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'Regla de negocio rechaza: factura no encontrada, ya cerrada, mismatch de monto, crédito sin cliente, margen bajo, banco no encontrado.',
  })
  async process(
    @Body() dto: ProcessPaymentDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
  ): Promise<ProcessPaymentResult> {
    // HIGH-3: validamos formato UUID v4 ANTES de tocar el service. Reintento
    // legítimo de cliente PlacePos envía v4 generado server-side; cualquier
    // otra cosa es bug de cliente y debe rechazarse temprano.
    let idempotencyKey: string | null = null;
    if (idempotencyKeyHeader !== undefined && idempotencyKeyHeader !== '') {
      if (!UUID_V4_REGEX.test(idempotencyKeyHeader)) {
        throw new BadRequestException({
          message: 'Idempotency-Key debe ser un UUID v4 válido.',
          payload: { code: 'INVALID_IDEMPOTENCY_KEY' },
        });
      }
      idempotencyKey = idempotencyKeyHeader;
    }

    const result = await this.paymentsService.process(
      dto,
      companyId,
      {
        id: currentUser.user_id,
        fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
        type: currentUser.type,
      },
      idempotencyKey,
    );

    if (!result.success) {
      // Paridad PlacePos: 422 con `{ success: false, error, payload: { code } }`.
      // Lanzar `UnprocessableEntityException` con `payload.code` permite que
      // `AllExceptionsFilter` formatee el error con el mismo shape exacto.
      throw new UnprocessableEntityException({
        message: result.message,
        payload: { code: result.code },
      });
    }

    // 201 + ResponseWrapperInterceptor → `{ success: true, payload: result }`.
    return result;
  }
}
