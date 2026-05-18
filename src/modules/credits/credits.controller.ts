import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { ProcessCreditPaymentDto } from './dto/process-credit-payment.dto';
import { CreditsService } from './credits.service';

/**
 * Endpoints `/credits` — paridad estricta PlacePos.
 *
 * PlacePos expone una sola ruta:
 *   - `POST /credits` → `processCreditPayment` (abono a un SaleCredit).
 *
 * Multi-tenancy: el `company_id` se inyecta vía `@CurrentCompany()` desde el
 * JWT — nunca del payload ni query.
 *
 * Roles: `owner | manager | employee` (todos pueden registrar abonos desde el
 * POS).
 */
@ApiTags('credits')
@ApiBearerAuth('bearer')
@Controller('credits')
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  // --------------------------------------------------------------------------
  // POST /credits
  // --------------------------------------------------------------------------

  @Post('/')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary:
      'Registrar abono a un crédito de venta. Espejo PlacePos POST /credits (processCreditPayment).',
  })
  @ApiBody({ type: ProcessCreditPaymentDto })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Abono registrado correctamente.',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'No se pudo procesar el abono (crédito inexistente, ya pagado, monto inválido, etc.).',
  })
  async processPayment(
    @Body() dto: ProcessCreditPaymentDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{
    success: true;
    message: string;
    payment_id: number;
    credit_status: string;
    credit_balance: number;
  }> {
    const fullName = `${user.name} ${user.lastname}`.trim();
    const result = await this.creditsService.processCreditPayment(dto, companyId, {
      id: user.user_id,
      fullName,
    });

    if (!result.success) {
      // Paridad PlacePos: 422 con `{ success: false, error, payload: { code } }`.
      // El `ResponseWrapperInterceptor` global aplica el envelope a partir de
      // la HttpException — el `payload.code` permite al cliente discriminar.
      throw new UnprocessableEntityException({
        message: result.message,
        payload: { code: result.code },
      });
    }

    return {
      success: true,
      message: result.message,
      payment_id: result.payment_id,
      credit_status: result.credit_status,
      credit_balance: result.credit_balance,
    };
  }
}
