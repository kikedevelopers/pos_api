import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '@/common/decorators/public.decorator';
import { AiCreditsAction } from '@/modules/ai/actions/ai-credits.action';
import type { AiCreditsStatus } from '@/modules/ai/internal/ai-usage';

import {
  GetAiUsageAction,
  type GlobalAiUsage,
  type TenantAiUsage,
} from './actions/get-ai-usage.action';
import { SalesAgentTenantAction, type TenantSalesAgent } from './actions/sales-agent-tenant.action';
import { AiUsageQueryDto } from './dto/ai-usage-query.dto';
import {
  ReleaseSalesAgentChatDto,
  UpdateSalesAgentAccessDto,
} from './dto/update-sales-agent-access.dto';
import { UpdateAiCreditsDto } from './dto/update-ai-credits.dto';
import { SuperadminSignatureGuard } from './guards/superadmin-signature.guard';

/**
 * Place (IA) en el panel superadmin: consumo de tokens (global y por negocio)
 * y créditos diarios por negocio. Misma autenticación que el resto de
 * `/superadmin/*`: firma Ed25519 del panel, sin JWT.
 */
@ApiTags('superadmin')
@Public()
@UseGuards(SuperadminSignatureGuard)
@Controller('superadmin')
export class SuperadminAiController {
  private readonly logger = new Logger(SuperadminAiController.name);

  constructor(
    private readonly getAiUsageAction: GetAiUsageAction,
    private readonly aiCredits: AiCreditsAction,
    private readonly salesAgentTenant: SalesAgentTenantAction,
  ) {}

  @Get('tenants/:companyId/sales-agent')
  @ApiOperation({
    summary: 'Asistente de ventas de un negocio: interruptor, canales y consumo de IA.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  tenantSalesAgent(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Query() query: AiUsageQueryDto,
  ): Promise<TenantSalesAgent> {
    return this.salesAgentTenant.get(companyId, query.from, query.to);
  }

  @Post('tenants/:companyId/sales-agent/release-chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reanuda el asistente de ventas en un chat que estaba en pausa.',
    description:
      'Body: { channel, chat_id }. Borra la toma de control vigente de ese chat: el agente ' +
      'vuelve a responder desde el próximo mensaje del cliente.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  releaseSalesAgentChat(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: ReleaseSalesAgentChatDto,
  ): Promise<{ released: boolean }> {
    return this.salesAgentTenant.releaseChat(companyId, dto.channel, dto.chat_id.trim());
  }

  @Patch('tenants/:companyId/sales-agent-access')
  @ApiOperation({
    summary: 'Habilita/inhabilita el asistente de ventas de ESTA company.',
    description:
      'Body: { enabled }. Apagado por defecto. Apagado: no responde en ningún canal (Telegram ' +
      'se detiene al instante), su configuración responde 403 SALES_AGENT_NOT_ENABLED y el ' +
      'catálogo deja de indexarse. Cada sucursal tiene el suyo.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  updateSalesAgentAccess(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: UpdateSalesAgentAccessDto,
  ): Promise<{ salesAgentEnabled: boolean }> {
    return this.salesAgentTenant.setAccess(companyId, dto.enabled);
  }

  @Get('ai/usage')
  @ApiOperation({
    summary: 'Consumo de Place de TODOS los negocios (tokens, preguntas, por día y por negocio).',
  })
  @ApiResponse({ status: HttpStatus.OK })
  globalUsage(@Query() query: AiUsageQueryDto): Promise<GlobalAiUsage> {
    return this.getAiUsageAction.global(query.from, query.to);
  }

  @Get('tenants/:companyId/ai')
  @ApiOperation({ summary: 'Place de un negocio: acceso, créditos del día y consumo de tokens.' })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  tenantUsage(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Query() query: AiUsageQueryDto,
  ): Promise<TenantAiUsage> {
    return this.getAiUsageAction.tenant(companyId, query.from, query.to);
  }

  @Patch('tenants/:companyId/ai-credits')
  @ApiOperation({
    summary: 'Fija las preguntas diarias que el negocio puede hacerle a Place (0 = bloqueado).',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'La company no existe' })
  async updateCredits(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: UpdateAiCreditsDto,
  ): Promise<AiCreditsStatus> {
    const saved = await this.aiCredits.setDailyCredits(companyId, dto.daily_credits);
    if (saved === null) {
      throw new NotFoundException(`Company ${companyId} no existe.`);
    }
    this.logger.log({
      event: 'superadmin.ai_credits.updated',
      companyId,
      dailyCredits: saved,
    });
    return this.aiCredits.status(companyId);
  }
}
