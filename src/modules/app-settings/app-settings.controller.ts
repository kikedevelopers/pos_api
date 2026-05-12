import { Body, Controller, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
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

import { AppSettingsService } from './app-settings.service';
import { AppSettingResponseDto, toAppSettingResponseDto } from './dto/app-setting-response.dto';
import { UpsertAppSettingDto } from './dto/upsert-app-setting.dto';

/**
 * Endpoints `/app-settings`.
 *
 * Roles: `owner` y `manager`. El `employee` operativo no toca configuración.
 *
 * Multi-tenancy: `@CurrentCompany()` propaga el `company_id` del JWT. El
 * payload nunca incluye `company_id` ni `key` en el body (la `key` va por
 * URL).
 *
 * Divergencia vs PlacePos local:
 *   - PlacePos expone endpoints específicos (`/color-mode`, `/pos-margins`)
 *     con shape custom. Aquí se ofrece el genérico clave-valor por defecto.
 *     Los endpoints específicos de PlacePos pueden añadirse en una fase
 *     posterior si el frontend cloud los requiere literalmente — para el
 *     MVP el cliente cloud puede usar `GET /app-settings/app_color_mode`
 *     y `PUT /app-settings/app_color_mode` con `{ value: 'dark' }`.
 */
@ApiTags('app-settings')
@ApiBearerAuth('bearer')
@Controller('app-settings')
export class AppSettingsController {
  constructor(private readonly appSettingsService: AppSettingsService) {}

  @Get()
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Listar todos los settings de la company autenticada' })
  @ApiResponse({ status: HttpStatus.OK, type: [AppSettingResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  async findAll(@CurrentCompany() companyId: number): Promise<AppSettingResponseDto[]> {
    const settings = await this.appSettingsService.findAll(companyId);
    return settings.map(toAppSettingResponseDto);
  }

  @Get(':key')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Leer el valor de un setting por su clave' })
  @ApiParam({ name: 'key', example: 'app_color_mode' })
  @ApiResponse({ status: HttpStatus.OK, type: AppSettingResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Setting no encontrado' })
  async findOne(
    @Param('key') key: string,
    @CurrentCompany() companyId: number,
  ): Promise<AppSettingResponseDto> {
    const setting = await this.appSettingsService.findByKey(key, companyId);
    return toAppSettingResponseDto(setting);
  }

  @Put(':key')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Set value de un setting (upsert)',
    description: 'Si la clave no existe, se crea. Si existe, se actualiza el value. Idempotente.',
  })
  @ApiParam({ name: 'key', example: 'app_color_mode' })
  @ApiBody({ type: UpsertAppSettingDto })
  @ApiResponse({ status: HttpStatus.OK, type: AppSettingResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  async upsert(
    @Param('key') key: string,
    @Body() dto: UpsertAppSettingDto,
    @CurrentCompany() companyId: number,
  ): Promise<AppSettingResponseDto> {
    const setting = await this.appSettingsService.upsert(key, dto.value, companyId);
    return toAppSettingResponseDto(setting);
  }
}
