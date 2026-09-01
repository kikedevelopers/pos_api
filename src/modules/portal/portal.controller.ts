import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { SkipActiveCompanyCheck } from '@/common/decorators/skip-active-company-check.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { SubscriptionResponseDto } from '@/modules/subscriptions/dto/subscription-response.dto';
import { SkipSubscriptionCheck } from '@/modules/subscriptions/skip-subscription-check.decorator';

import { ChangePlanAction } from './actions/change-plan.action';
import { GetPortalAccountAction } from './actions/get-portal-account.action';
import { PortalLoginAction } from './actions/portal-login.action';
import { ChangePlanDto } from './dto/change-plan.dto';
import { PortalAccountResponseDto } from './dto/portal-account.dto';
import { PortalLoginDto, PortalLoginResponseDto } from './dto/portal-login.dto';
import { PortalRoute } from './portal-route.decorator';

/**
 * Portal de facturación de la landing (`placepos_lp`). Cloud-only.
 *
 * Es la superficie MÍNIMA que necesita alguien que solo quiere ver o cambiar su
 * plan: entrar, verse y elegir plan. Nada de datos del negocio.
 *
 * Las tres decisiones que gobiernan este controller:
 *
 *   - `@SkipSubscriptionCheck()` — con la suscripción vencida hay que poder
 *     entrar; si no, la pantalla para arreglarlo estaría detrás del bloqueo que
 *     se quiere arreglar.
 *   - `@PortalRoute()` — a cambio de lo anterior, el token del portal SOLO
 *     sirve aquí (`PortalScopeGuard`).
 *   - `@Roles('owner')` — la suscripción y su cobro son del dueño.
 */
@ApiTags('portal')
@Controller('portal')
@PortalRoute()
@SkipSubscriptionCheck()
@SkipActiveCompanyCheck()
export class PortalController {
  constructor(
    private readonly portalLoginAction: PortalLoginAction,
    private readonly getPortalAccountAction: GetPortalAccountAction,
    private readonly changePlanAction: ChangePlanAction,
  ) {}

  @Post('auth/login')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Mismo techo que el login de la app: 10 intentos/minuto.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Login del portal de facturación (solo dueños)',
    description:
      'Mismas credenciales que la app. NO se bloquea por suscripción vencida —es ' +
      'justo quien necesita entrar— y a cambio emite un token acotado a `/portal/*`.',
  })
  @ApiBody({ type: PortalLoginDto })
  @ApiResponse({ status: HttpStatus.OK, type: PortalLoginResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Credenciales inválidas' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Cuenta sin activar (ACCOUNT_NOT_ACTIVATED) o no es dueño (PORTAL_OWNER_ONLY)',
  })
  @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, description: 'Rate limit' })
  login(@Body() dto: PortalLoginDto): Promise<PortalLoginResponseDto> {
    return this.portalLoginAction.execute(dto);
  }

  @Get('account')
  @ApiBearerAuth('bearer')
  @Roles('owner')
  @ApiOperation({ summary: 'Cuenta, negocio y estado de la suscripción' })
  @ApiResponse({ status: HttpStatus.OK, type: PortalAccountResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  account(
    @CurrentUser() user: AuthUser,
    @CurrentCompany() companyId: number,
  ): Promise<PortalAccountResponseDto> {
    return this.getPortalAccountAction.execute(user.user_id, companyId);
  }

  @Post('subscription/plan')
  @ApiBearerAuth('bearer')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pedir un plan (upgrade/downgrade)',
    description:
      'Registra la INTENCIÓN: un plan de pago queda `payment_pending` hasta que se ' +
      'confirme el cobro. `free` retira la solicitud o marca la no-renovación.',
  })
  @ApiBody({ type: ChangePlanDto })
  @ApiResponse({ status: HttpStatus.OK, type: SubscriptionResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Suscripción no encontrada' })
  changePlan(
    @CurrentUser() user: AuthUser,
    @CurrentCompany() companyId: number,
    @Body() dto: ChangePlanDto,
  ): Promise<SubscriptionResponseDto> {
    return this.changePlanAction.execute(user.user_id, companyId, dto.plan);
  }
}
