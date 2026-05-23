import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpStatus,
  Post,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
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
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Procesa un pago de un pedido (ORDER → SALE). Genera folio SALE, descuenta stock, registra SalePayment + SaleCredit + side effects de caja/banco. Acepta header opcional Idempotency-Key (UUID v4) para deduplicar reintentos.',
  })
  @ApiBody({ type: ProcessPaymentDto })
  @ApiHeader({
    name: 'Idempotency-Key',
    description:
      'UUID v4 opcional. Si llega, dos requests idénticas devuelven el mismo SalePayment sin duplicar cobro.',
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
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
  ): Promise<ProcessPaymentResult> {
    // HIGH-3: validamos formato UUID v4 ANTES de tocar el service. Reintento
    // legítimo de cliente PlacePos envía v4 generado server-side; cualquier
    // otra cosa es bug de cliente y debe rechazarse temprano.
    //
    // Paridad cliente PlacePos: el cliente Electron envía la llave dentro del
    // body como `client_operation_id`. Si el caller HTTP genérico prefiere el
    // header, ese gana. El DTO ya valida formato UUID v4 sobre el body field,
    // así que aquí solo validamos el header.
    let idempotencyKey: string | null = null;
    if (idempotencyKeyHeader !== undefined && idempotencyKeyHeader !== '') {
      if (!UUID_V4_REGEX.test(idempotencyKeyHeader)) {
        throw new BadRequestException({
          message: 'Idempotency-Key debe ser un UUID v4 válido.',
          payload: { code: 'INVALID_IDEMPOTENCY_KEY' },
        });
      }
      idempotencyKey = idempotencyKeyHeader;
    } else if (dto.client_operation_id) {
      idempotencyKey = dto.client_operation_id;
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

    // Idempotencia: si la action detectó que este uuid ya fue procesado
    // (`result.replay === true`), devolvemos 200 OK con el pago existente
    // — paridad con la regla del brief: "si llega un uuid ya procesado,
    // devolver 200 con el pago existente (no 409)". El primer procesamiento
    // sigue devolviendo 201 CREATED.
    if (result.replay === true) {
      res.status(HttpStatus.OK);
    } else {
      res.status(HttpStatus.CREATED);
    }

    // Limpiamos la marca interna `replay` antes de devolver — no forma parte
    // del contrato HTTP. ResponseWrapperInterceptor envuelve con
    // `{ success: true, payload }`.
    const { replay: _replay, ...publicResult } = result;
    void _replay;
    return publicResult;
  }
}
