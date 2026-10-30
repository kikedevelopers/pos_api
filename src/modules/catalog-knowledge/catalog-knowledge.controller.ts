import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { SalesAgentEnabledGuard } from '@/modules/sales-agent-access/sales-agent-enabled.guard';

import { CatalogSemanticService } from './catalog-semantic.service';
import { UpdateAssistantProfileDto } from './dto/update-assistant-profile.dto';
import type { ProfileSuggestion } from './internal/suggestion';
import {
  ProductAssistantProfileService,
  type AssistantProfileView,
} from './product-assistant-profile.service';
import { SuggestAssistantProfileAction } from './suggest-assistant-profile.action';

/**
 * `/inventory/:id/assistant-profile` — ficha "Para el asistente" de un producto
 * base (contexto para el vendedor IA). Mismos permisos que editar el producto,
 * y solo si el negocio tiene el asistente de ventas habilitado (403
 * SALES_AGENT_NOT_ENABLED).
 */
@ApiTags('inventory')
@ApiBearerAuth('bearer')
@Controller('inventory')
@UseGuards(SalesAgentEnabledGuard)
export class CatalogKnowledgeController {
  constructor(
    private readonly profiles: ProductAssistantProfileService,
    private readonly suggest: SuggestAssistantProfileAction,
    private readonly semantic: CatalogSemanticService,
  ) {}

  @Get(':id/assistant-profile')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessInventory')
  @ApiOperation({ summary: 'Ficha "Para el asistente" del producto base.' })
  @ApiParam({ name: 'id', type: 'integer' })
  getProfile(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<AssistantProfileView> {
    return this.profiles.get(companyId, id);
  }

  @Put(':id/assistant-profile')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessInventory')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Guarda la ficha "Para el asistente" y la reindexa.' })
  @ApiParam({ name: 'id', type: 'integer' })
  async updateProfile(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAssistantProfileDto,
    @CurrentCompany() companyId: number,
  ): Promise<AssistantProfileView> {
    const view = await this.profiles.update(companyId, id, dto);
    // Reindexa en segundo plano: el asistente la aprovecha en segundos, sin
    // esperar la corrida periódica ni demorar la respuesta.
    void this.semantic.indexCompany(companyId, 1, [id]).catch(() => undefined);
    return view;
  }

  @Post(':id/assistant-profile/suggest')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessInventory')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Propone la ficha con IA (no guarda).' })
  @ApiParam({ name: 'id', type: 'integer' })
  suggestProfile(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ProfileSuggestion> {
    return this.suggest.execute(companyId, id);
  }
}
