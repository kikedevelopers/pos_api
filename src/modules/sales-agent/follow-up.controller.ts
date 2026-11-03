import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { AdminLevelGuard } from '@/common/guards/admin-level.guard';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { SalesAgentEnabledGuard } from '@/modules/sales-agent-access/sales-agent-enabled.guard';

import { DraftFollowUpDto, RecordFollowUpDto } from './dto/follow-ups.dto';
import {
  FollowUpService,
  type FollowUpAvailability,
  type FollowUpDraftResult,
  type FollowUpView,
} from './follow-up.service';

/**
 * `/sales-agent/follow-ups` — seguimientos del agente a clientes (Informes →
 * Clientes). Feature CLOUD con el mismo gating del agente: nivel admin y agente
 * habilitado para el negocio.
 *
 * El servidor NUNCA envía: redacta (`draft`) y registra lo que el escritorio ya
 * envió por el WhatsApp del negocio (`record`).
 */
@ApiTags('sales-agent-follow-ups')
@ApiBearerAuth('bearer')
@Controller('sales-agent/follow-ups')
@UseGuards(AdminLevelGuard, SalesAgentEnabledGuard)
export class FollowUpController {
  constructor(private readonly followUps: FollowUpService) {}

  @Get('availability')
  @ApiOperation({ summary: '¿Se puede hacer seguimiento? (IA lista y WhatsApp del agente activo)' })
  availability(@CurrentCompany() companyId: number): Promise<FollowUpAvailability> {
    return this.followUps.availability(companyId);
  }

  @Get('last')
  @ApiOperation({ summary: 'Fecha del último seguimiento enviado a cada cliente.' })
  last(
    @CurrentCompany() companyId: number,
  ): Promise<Array<{ customer_id: number; created_at: string }>> {
    return this.followUps.lastByCustomer(companyId);
  }

  @Post('draft')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'El agente redacta un saludo de seguimiento personal (últimas 3 ventas + catálogo).',
  })
  draft(
    @Body() dto: DraftFollowUpDto,
    @CurrentCompany() companyId: number,
  ): Promise<FollowUpDraftResult> {
    return this.followUps.draft(companyId, dto.customer_id, dto.previous_messages ?? []);
  }

  @Post()
  @ApiOperation({ summary: 'Registra un seguimiento ya enviado (contexto para el agente).' })
  record(
    @Body() dto: RecordFollowUpDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<FollowUpView> {
    return this.followUps.record(companyId, user, dto);
  }
}
