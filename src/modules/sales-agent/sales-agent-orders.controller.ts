import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { AdminLevelGuard } from '@/common/guards/admin-level.guard';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { SalesAgentEnabledGuard } from '@/modules/sales-agent-access/sales-agent-enabled.guard';

import {
  LinkAgentOrderTicketDto,
  ListAgentOrdersQueryDto,
  UpdateAgentOrderStatusDto,
} from './dto/agent-orders.dto';
import {
  SalesAgentOrdersService,
  type AgentOrderView,
  type AgentOrdersList,
} from './sales-agent-orders.service';

/**
 * `/sales-agent-orders` — bandeja de pedidos que cerró el agente de ventas
 * (informe "Informes → Agente"). Feature CLOUD.
 *
 * Gating igual que el resto del agente: NIVEL ADMIN (`AdminLevelGuard`) y solo
 * si el negocio tiene el agente habilitado (`SalesAgentEnabledGuard`). Trae
 * datos personales del cliente (nombre, teléfono, dirección).
 */
@ApiTags('sales-agent-orders')
@ApiBearerAuth('bearer')
@Controller('sales-agent-orders')
@UseGuards(AdminLevelGuard, SalesAgentEnabledGuard)
export class SalesAgentOrdersController {
  constructor(private readonly orders: SalesAgentOrdersService) {}

  @Get()
  @ApiOperation({ summary: 'Pedidos del agente (por estado, rango y búsqueda) + resumen.' })
  @ApiResponse({ status: HttpStatus.OK })
  list(
    @Query() query: ListAgentOrdersQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<AgentOrdersList> {
    return this.orders.list(companyId, {
      status: query.status ?? 'pending',
      from: query.from,
      to: query.to,
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 25,
    });
  }

  @Get('pending-count')
  @ApiOperation({ summary: 'Pedidos del agente por tomar (contador del menú).' })
  @ApiResponse({ status: HttpStatus.OK })
  async pendingCount(@CurrentCompany() companyId: number): Promise<{ count: number }> {
    return { count: await this.orders.pendingCount(companyId) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un pedido del agente.' })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<AgentOrderView> {
    return this.orders.findOne(companyId, id);
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca el pedido como tomado, descartado o de nuevo por tomar.' })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Transición no permitida.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAgentOrderStatusDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<AgentOrderView> {
    return this.orders.updateStatus(companyId, id, {
      status: dto.status,
      note: dto.note,
      userId: user.user_id,
    });
  }

  @Post(':id/link-ticket')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enlaza el pedido con el ticket que se registró en el POS (queda tomado).',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Ya enlazado a otro ticket/pedido.' })
  linkTicket(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LinkAgentOrderTicketDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<AgentOrderView> {
    return this.orders.linkTicket(companyId, id, {
      saleInvoiceId: dto.sale_invoice_id,
      userId: user.user_id,
    });
  }
}
