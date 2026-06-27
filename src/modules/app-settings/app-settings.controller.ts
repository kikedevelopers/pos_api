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
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { GetCustomerPointsAction } from './actions/get-customer-points.action';
import { GetPosMarginsAction } from './actions/get-pos-margins.action';
import { GetStrictInventoryAction } from './actions/get-strict-inventory.action';
import { UpsertCustomerPointsAction } from './actions/upsert-customer-points.action';
import { UpsertPosMarginsAction } from './actions/upsert-pos-margins.action';
import { UpsertStrictInventoryAction } from './actions/upsert-strict-inventory.action';
import { AppSettingsService } from './app-settings.service';
import { AppSettingResponseDto, toAppSettingResponseDto } from './dto/app-setting-response.dto';
import { CustomerPointsConfigDto, UpdateCustomerPointsDto } from './dto/customer-points.dto';
import { PosMarginsConfigDto, UpdatePosMarginsDto } from './dto/pos-margins.dto';
import { StrictInventoryConfigDto, UpdateStrictInventoryDto } from './dto/strict-inventory.dto';
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
 * Endpoints específicos paridad PlacePos:
 *   - `GET/PUT /app-settings/pos-margins`     → `{ enabled, margins[] }`.
 *   - `GET/PUT /app-settings/strict-inventory` → `{ enabled }` (PUT solo
 *     `owner|superadmin`).
 *
 * Convivencia con el endpoint genérico:
 *   - El cliente cloud puede seguir usando `GET /app-settings/app_color_mode`
 *     y `PUT /app-settings/app_color_mode` con `{ value: 'dark' }` para
 *     settings simples clave-valor.
 *   - Los endpoints específicos DEBEN declararse antes del `@Get(':key')`
 *     genérico — el orden importa en NestJS y un `:key='pos-margins'`
 *     genérico devolvería NOT_FOUND.
 */
@ApiTags('app-settings')
@ApiBearerAuth('bearer')
@Controller('app-settings')
export class AppSettingsController {
  constructor(
    private readonly appSettingsService: AppSettingsService,
    private readonly getPosMarginsAction: GetPosMarginsAction,
    private readonly upsertPosMarginsAction: UpsertPosMarginsAction,
    private readonly getStrictInventoryAction: GetStrictInventoryAction,
    private readonly upsertStrictInventoryAction: UpsertStrictInventoryAction,
    private readonly getCustomerPointsAction: GetCustomerPointsAction,
    private readonly upsertCustomerPointsAction: UpsertCustomerPointsAction,
  ) {}

  // ----------------------------------------------------------------------
  // Endpoints específicos — paridad PlacePos. Declarados ANTES del
  // `@Get(':key')` genérico: el router los matchea por path exacto y
  // descarta el wildcard. Si se mueven, romperán con NOT_FOUND.
  // ----------------------------------------------------------------------

  @Get('pos-margins')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Configuración de márgenes POS',
    description: 'Lee `pos_margins_enabled` + `pos_margins` y devuelve `{ enabled, margins }`.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: PosMarginsConfigDto })
  async getPosMargins(@CurrentCompany() companyId: number): Promise<PosMarginsConfigDto> {
    return this.getPosMarginsAction.execute(companyId);
  }

  @Put('pos-margins')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Set configuración de márgenes POS',
    description:
      'Upsert atómico de `pos_margins_enabled` + `pos_margins`. Reglas: si `enabled=true` debe haber ≥1 margen; orden ascendente estricto.',
  })
  @ApiBody({ type: UpdatePosMarginsDto })
  @ApiResponse({ status: HttpStatus.OK, type: PosMarginsConfigDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  async upsertPosMargins(
    @Body() dto: UpdatePosMarginsDto,
    @CurrentCompany() companyId: number,
  ): Promise<PosMarginsConfigDto> {
    return this.upsertPosMarginsAction.execute(dto, companyId);
  }

  @Get('strict-inventory')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Flag global de control estricto de inventario',
    description: 'Devuelve `{ enabled }` desde la key `strict_inventory_control`.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: StrictInventoryConfigDto })
  async getStrictInventory(@CurrentCompany() companyId: number): Promise<StrictInventoryConfigDto> {
    return this.getStrictInventoryAction.execute(companyId);
  }

  @Put('strict-inventory')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'superadmin', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Set flag global de control estricto de inventario',
    description:
      'Solo `owner` o `superadmin` pueden modificar este flag — afecta toda la operación del comercio.',
  })
  @ApiBody({ type: UpdateStrictInventoryDto })
  @ApiResponse({ status: HttpStatus.OK, type: StrictInventoryConfigDto })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Solo un administrador puede modificar esta configuración',
  })
  async upsertStrictInventory(
    @Body() dto: UpdateStrictInventoryDto,
    @CurrentCompany() companyId: number,
  ): Promise<StrictInventoryConfigDto> {
    return this.upsertStrictInventoryAction.execute(dto, companyId);
  }

  @Get('customer-points')
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Configuración del sistema de puntos de cliente',
    description: 'Lee las keys `customer_points_*` y devuelve `{ enabled, pesoBase, perBase }`.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: CustomerPointsConfigDto })
  async getCustomerPoints(@CurrentCompany() companyId: number): Promise<CustomerPointsConfigDto> {
    return this.getCustomerPointsAction.execute(companyId);
  }

  @Put('customer-points')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Set configuración del sistema de puntos de cliente',
    description:
      'Upsert atómico de `customer_points_enabled` + `customer_points_peso_base` + `customer_points_per_base`. Afecta el otorgamiento de puntos en todas las ventas.',
  })
  @ApiBody({ type: UpdateCustomerPointsDto })
  @ApiResponse({ status: HttpStatus.OK, type: CustomerPointsConfigDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  async upsertCustomerPoints(
    @Body() dto: UpdateCustomerPointsDto,
    @CurrentCompany() companyId: number,
  ): Promise<CustomerPointsConfigDto> {
    return this.upsertCustomerPointsAction.execute(dto, companyId);
  }

  // ----------------------------------------------------------------------
  // Endpoints genéricos clave-valor (DESPUÉS de los específicos).
  // ----------------------------------------------------------------------

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
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
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
