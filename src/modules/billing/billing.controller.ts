import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { SkipActiveCompanyCheck } from '@/common/decorators/skip-active-company-check.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { PortalRoute } from '@/modules/portal/portal-route.decorator';
import { SkipSubscriptionCheck } from '@/modules/subscriptions/skip-subscription-check.decorator';

import { ConfirmPaymentAction } from './actions/confirm-payment.action';
import { CreateCheckoutAction } from './actions/create-checkout.action';
import { HandleWompiEventAction } from './actions/handle-wompi-event.action';
import { ListPaymentsAction } from './actions/list-payments.action';
import {
  ConfirmPaymentDto,
  CreateCheckoutDto,
  PaymentResponseDto,
} from './dto/payment-response.dto';
import type { WompiEvent } from './wompi/wompi.types';

/**
 * Pagos de la suscripción desde el portal de la landing. Mismas reglas que
 * `PortalController`: token del portal, solo el dueño, sin bloqueo por
 * suscripción vencida (es justo quien necesita pagar).
 */
@ApiTags('portal')
@Controller('portal/payments')
@PortalRoute()
@SkipSubscriptionCheck()
@SkipActiveCompanyCheck()
export class PortalPaymentsController {
  constructor(
    private readonly createCheckoutAction: CreateCheckoutAction,
    private readonly confirmPaymentAction: ConfirmPaymentAction,
    private readonly listPaymentsAction: ListPaymentsAction,
  ) {}

  @Post('checkout')
  @ApiBearerAuth('bearer')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Abre el pago de un plan (link de pago de Wompi de un solo uso)' })
  @ApiBody({ type: CreateCheckoutDto })
  @ApiResponse({ status: HttpStatus.OK, type: PaymentResponseDto })
  @ApiResponse({ status: HttpStatus.SERVICE_UNAVAILABLE, description: 'Pagos no configurados' })
  @ApiResponse({ status: HttpStatus.BAD_GATEWAY, description: 'Wompi no respondió' })
  checkout(
    @CurrentUser() user: AuthUser,
    @CurrentCompany() companyId: number,
    @Body() dto: CreateCheckoutDto,
  ): Promise<PaymentResponseDto> {
    return this.createCheckoutAction.execute(user.user_id, companyId, dto.plan);
  }

  @Get()
  @ApiBearerAuth('bearer')
  @Roles('owner')
  @ApiOperation({ summary: 'Últimos pagos de la suscripción' })
  @ApiResponse({ status: HttpStatus.OK, type: [PaymentResponseDto] })
  list(
    @CurrentUser() user: AuthUser,
    @CurrentCompany() companyId: number,
  ): Promise<PaymentResponseDto[]> {
    return this.listPaymentsAction.execute(user.user_id, companyId);
  }

  @Post(':reference/confirm')
  @ApiBearerAuth('bearer')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Estado de un pago (verifica contra Wompi si hay transacción)',
    description: 'Lo llama la pantalla de regreso del checkout con el `?id=` que añade Wompi.',
  })
  @ApiBody({ type: ConfirmPaymentDto })
  @ApiResponse({ status: HttpStatus.OK, type: PaymentResponseDto })
  confirm(
    @CurrentUser() user: AuthUser,
    @CurrentCompany() companyId: number,
    @Param('reference', new ParseUUIDPipe()) reference: string,
    @Body() dto: ConfirmPaymentDto,
  ): Promise<PaymentResponseDto> {
    return this.confirmPaymentAction.execute(
      user.user_id,
      companyId,
      reference,
      dto.transaction_id,
    );
  }
}

/**
 * Webhook de eventos de Wompi. Público (lo llama Wompi), autenticado por la
 * FIRMA del evento. Responde 200 exacto: Wompi trata cualquier otro código
 * como entrega fallida y reintenta.
 */
@Controller('webhooks/wompi')
@Public()
@SkipThrottle()
@SkipSubscriptionCheck()
@SkipActiveCompanyCheck()
export class WompiWebhookController {
  constructor(private readonly handleWompiEventAction: HandleWompiEventAction) {}

  @Post('events')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  events(
    @Body() event: WompiEvent,
    @Headers('x-event-checksum') checksum?: string,
  ): Promise<{ received: true; outcome: string }> {
    return this.handleWompiEventAction.execute(event, checksum);
  }
}
