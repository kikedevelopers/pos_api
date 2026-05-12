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

import { AlertConfigsService } from './alert-configs.service';
import { AlertConfigResponseDto, toAlertConfigResponseDto } from './dto/alert-config-response.dto';
import { UpsertAlertConfigDto } from './dto/upsert-alert-config.dto';

/**
 * Validador inline del path param `:type` — snake_case (sin espacios,
 * caracteres acotados). Centralizado para reusar entre GET y PUT.
 */
const TYPE_RE = /^[a-z][a-z0-9_]{0,49}$/;

function assertValidType(rawType: string): string {
  if (!TYPE_RE.test(rawType)) {
    throw new BadRequestException(
      'type debe ser snake_case (a-z, 0-9, _), comenzando con letra (max 50)',
    );
  }
  return rawType;
}

/**
 * Endpoints `/alert-configs`. Espejo PlacePos `alert-configs.routes.ts`
 * salvo `POST /:type/run-now` (Fase 11 — evaluators).
 *
 * Roles: `owner` y `manager`. El `employee` no configura alertas.
 *
 * Multi-tenancy: `@CurrentCompany()` propaga `company_id` del JWT.
 */
@ApiTags('alert-configs')
@ApiBearerAuth('bearer')
@Controller('alert-configs')
export class AlertConfigsController {
  constructor(private readonly alertConfigsService: AlertConfigsService) {}

  @Get()
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Listar configuraciones de alerta de la company autenticada' })
  @ApiResponse({ status: HttpStatus.OK, type: [AlertConfigResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  async findAll(@CurrentCompany() companyId: number): Promise<AlertConfigResponseDto[]> {
    const configs = await this.alertConfigsService.findAll(companyId);
    return configs.map(toAlertConfigResponseDto);
  }

  @Get(':type')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Leer configuración de un tipo de alerta' })
  @ApiParam({ name: 'type', example: 'low_stock' })
  @ApiResponse({ status: HttpStatus.OK, type: AlertConfigResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'type inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Configuración de alerta no encontrada',
  })
  async findOne(
    @Param('type') typeRaw: string,
    @CurrentCompany() companyId: number,
  ): Promise<AlertConfigResponseDto> {
    const type = assertValidType(typeRaw);
    const config = await this.alertConfigsService.findByType(type, companyId);
    return toAlertConfigResponseDto(config);
  }

  @Put(':type')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Crear o actualizar configuración de un tipo de alerta (upsert)',
    description:
      'Si la configuración no existe se crea con `type` del path. Idempotente. NOTA: los evaluators que consumen `config` se implementan en Fase 11.',
  })
  @ApiParam({ name: 'type', example: 'low_stock' })
  @ApiBody({ type: UpsertAlertConfigDto })
  @ApiResponse({ status: HttpStatus.OK, type: AlertConfigResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload o type inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  async upsert(
    @Param('type') typeRaw: string,
    @Body() dto: UpsertAlertConfigDto,
    @CurrentCompany() companyId: number,
  ): Promise<AlertConfigResponseDto> {
    const type = assertValidType(typeRaw);
    const config = await this.alertConfigsService.upsert(type, dto, companyId);
    return toAlertConfigResponseDto(config);
  }
}
