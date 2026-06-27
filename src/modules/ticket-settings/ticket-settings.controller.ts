import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { UpdateTicketSettingDto } from './dto/update-ticket-setting.dto';
import {
  TicketSettingResponseDto,
  toTicketSettingResponseDto,
} from './dto/ticket-setting-response.dto';
import { TicketSettingsService } from './ticket-settings.service';

/**
 * Endpoints `/ticket-settings`.
 *
 * Roles:
 *   - `GET`: `owner` y `manager` (configuración del negocio; el `employee`
 *     operativo no la consulta).
 *   - `PUT`: `owner` y `manager`.
 *
 * Multi-tenancy: `@CurrentCompany()` propaga el `company_id` del JWT al
 * service. El payload nunca incluye `company_id`.
 *
 * Paridad PlacePos: la URL utiliza `:id` (entero del DB), NO el enum
 * `:ticket_type`. El cliente Electron espera enteros como param.
 */
@ApiTags('ticket-settings')
@ApiBearerAuth('bearer')
@Controller('ticket-settings')
export class TicketSettingsController {
  constructor(private readonly ticketSettingsService: TicketSettingsService) {}

  @Get()
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Listar configuraciones de folios de la company autenticada' })
  @ApiResponse({ status: HttpStatus.OK, type: [TicketSettingResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  async findAll(@CurrentCompany() companyId: number): Promise<TicketSettingResponseDto[]> {
    const settings = await this.ticketSettingsService.findAll(companyId);
    return settings.map(toTicketSettingResponseDto);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Actualizar prefix/suffix de la configuración de folio',
    description:
      '`current_number` NO se modifica vía este endpoint — cambia exclusivamente al crear ventas/compras/notas.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiBody({ type: UpdateTicketSettingDto })
  @ApiResponse({ status: HttpStatus.OK, type: TicketSettingResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Configuración de folio no encontrada',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Prefix duplicado dentro de la company',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTicketSettingDto,
    @CurrentCompany() companyId: number,
  ): Promise<TicketSettingResponseDto> {
    const setting = await this.ticketSettingsService.update(id, dto, companyId);
    return toTicketSettingResponseDto(setting);
  }
}
