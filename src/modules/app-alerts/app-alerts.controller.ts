import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { AppAlertsService } from './app-alerts.service';
import {
  ListAlertsResponseDto,
  MarkAllReadResponseDto,
  UnreadCountResponseDto,
  toAppAlertResponseDto,
} from './dto/app-alert-response.dto';
import { ListAlertsQueryDto } from './dto/list-alerts-query.dto';

/**
 * Endpoints `/app-alerts`. Espejo PlacePos `app-alerts.routes.ts`.
 *
 * Roles: cualquier rol autenticado (`owner`, `manager`, `employee`). Las
 * alertas son del negocio; cualquier usuario que opere el POS debe poder
 * verlas. PUT también queda abierto: leerlas es operacional, no
 * administrativo. PlacePos no las restringe por rol.
 *
 * Multi-tenancy: `@CurrentCompany()` propaga `company_id` del JWT al
 * service. Todas las queries filtran por `company_id`.
 */
@ApiTags('app-alerts')
@ApiBearerAuth('bearer')
@Controller('app-alerts')
export class AppAlertsController {
  constructor(private readonly appAlertsService: AppAlertsService) {}

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar alertas de la company autenticada' })
  @ApiQuery({ name: 'unread_only', required: false, type: Boolean })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: HttpStatus.OK, type: ListAlertsResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async findAll(
    @Query() query: ListAlertsQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<ListAlertsResponseDto> {
    // Defaults se aplican aquí porque los query params pueden llegar
    // undefined incluso con `@IsOptional()`.
    const params = {
      unreadOnly: query.unread_only ?? false,
      limit: query.limit ?? 50,
    };
    const result = await this.appAlertsService.findAll(companyId, params);
    return {
      alerts: result.alerts.map(toAppAlertResponseDto),
      unread_count: result.unread_count,
    };
  }

  @Get('unread-count')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Devuelve el contador de alertas no leídas (badge UI)' })
  @ApiResponse({ status: HttpStatus.OK, type: UnreadCountResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async unreadCount(@CurrentCompany() companyId: number): Promise<UnreadCountResponseDto> {
    const count = await this.appAlertsService.countUnread(companyId);
    return { count };
  }

  @Put('read-all')
  @HttpCode(HttpStatus.OK)
  // HIGH-4 auditoría: las alertas son administrativas (break_even_reached,
  // inactive_customer, etc.). El employee no debería marcarlas leídas y
  // ocultar señales al owner. Restringido a owner|manager.
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Marca como leídas todas las alertas no leídas de la company',
    description: 'Idempotente. Devuelve marked_count = 0 si no había alertas no leídas.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: MarkAllReadResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async markAllRead(@CurrentCompany() companyId: number): Promise<MarkAllReadResponseDto> {
    return this.appAlertsService.markAllRead(companyId);
  }

  @Put(':id/read')
  @HttpCode(HttpStatus.OK)
  // HIGH-4 auditoría: idem `read-all`. Restringido a owner|manager.
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Marca una alerta específica como leída',
    description: 'Idempotente. Si ya estaba leída, no hace nada.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Marcada como leída (payload null)' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Alerta no encontrada' })
  async markRead(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<null> {
    await this.appAlertsService.markRead(id, companyId);
    return null;
  }
}
