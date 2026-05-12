import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { Roles } from '@/common/decorators/roles.decorator';

import { UpdateTicketSettingDto } from './dto/update-ticket-setting.dto';
import {
  TicketSettingResponseDto,
  toTicketSettingResponseDto,
} from './dto/ticket-setting-response.dto';
import { TicketSettingType } from './entities/ticket-setting.entity';
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
 * Divergencia vs PlacePos local: PlacePos no expone HTTP endpoints para
 * `ticket-settings` (el cliente lee/escribe directo sobre la entidad). Este
 * API los añade para que el frontend cloud pueda personalizar prefix/suffix
 * por tipo de ticket sin un endpoint genérico. Es paridad por extensión
 * (no rompe nada en el cliente local).
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

  @Put(':ticket_type')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Actualizar prefix/suffix de la configuración de folio',
    description:
      '`current_number` NO se modifica vía este endpoint — cambia exclusivamente al crear ventas/compras/notas.',
  })
  @ApiParam({ name: 'ticket_type', enum: TicketSettingType })
  @ApiBody({ type: UpdateTicketSettingDto })
  @ApiResponse({ status: HttpStatus.OK, type: TicketSettingResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'ticket_type inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Configuración de folio no encontrada',
  })
  async update(
    @Param('ticket_type') ticketTypeRaw: string,
    @Body() dto: UpdateTicketSettingDto,
    @CurrentCompany() companyId: number,
  ): Promise<TicketSettingResponseDto> {
    // Validación manual del enum a nivel ruta. `ParseEnumPipe` existe en
    // Nest 10 pero su shape de error difiere entre versiones — el control
    // explícito asegura un mensaje en español y status 400 consistente.
    if (!Object.values(TicketSettingType).includes(ticketTypeRaw as TicketSettingType)) {
      throw new BadRequestException(
        `ticket_type debe ser uno de: ${Object.values(TicketSettingType).join(', ')}`,
      );
    }
    const ticketType = ticketTypeRaw as TicketSettingType;

    const setting = await this.ticketSettingsService.update(ticketType, dto, companyId);
    return toTicketSettingResponseDto(setting);
  }
}
