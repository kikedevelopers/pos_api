import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
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
import { GetEnableCreditPaymentAction } from './actions/get-enable-credit-payment.action';
import { GetEnableThirdPartyLoanAction } from './actions/get-enable-third-party-loan.action';
import { GetIncludeOrdersInReportsAction } from './actions/get-include-orders-in-reports.action';
import { GetPosMarginsAction } from './actions/get-pos-margins.action';
import { GetShowAllBaseProductsInPurchasesAction } from './actions/get-show-all-base-products-in-purchases.action';
import { GetShowDailyQuotaBarAction } from './actions/get-show-daily-quota-bar.action';
import { GetStrictInventoryAction } from './actions/get-strict-inventory.action';
import { GetTicketPrintAction } from './actions/get-ticket-print.action';
import { GetTurnosAction } from './actions/get-turnos.action';
import { ResetTurnosCounterAction } from './actions/reset-turnos-counter.action';
import { UpsertCustomerPointsAction } from './actions/upsert-customer-points.action';
import { UpsertEnableCreditPaymentAction } from './actions/upsert-enable-credit-payment.action';
import { UpsertEnableThirdPartyLoanAction } from './actions/upsert-enable-third-party-loan.action';
import { UpsertIncludeOrdersInReportsAction } from './actions/upsert-include-orders-in-reports.action';
import { UpsertPosMarginsAction } from './actions/upsert-pos-margins.action';
import { UpsertShowAllBaseProductsInPurchasesAction } from './actions/upsert-show-all-base-products-in-purchases.action';
import { UpsertShowDailyQuotaBarAction } from './actions/upsert-show-daily-quota-bar.action';
import { UpsertStrictInventoryAction } from './actions/upsert-strict-inventory.action';
import { UpsertTicketPrintAction } from './actions/upsert-ticket-print.action';
import { UpsertTurnosAction } from './actions/upsert-turnos.action';
import { AppSettingsService } from './app-settings.service';
import { AppSettingResponseDto, toAppSettingResponseDto } from './dto/app-setting-response.dto';
import { CreditPaymentConfigDto, UpdateCreditPaymentDto } from './dto/credit-payment.dto';
import { CustomerPointsConfigDto, UpdateCustomerPointsDto } from './dto/customer-points.dto';
import { ThirdPartyLoanConfigDto, UpdateThirdPartyLoanDto } from './dto/third-party-loan.dto';
import {
  IncludeOrdersInReportsConfigDto,
  UpdateIncludeOrdersInReportsDto,
} from './dto/include-orders-in-reports.dto';
import { PosMarginsConfigDto, UpdatePosMarginsDto } from './dto/pos-margins.dto';
import {
  ShowAllBaseProductsInPurchasesConfigDto,
  UpdateShowAllBaseProductsInPurchasesDto,
} from './dto/show-all-base-products-in-purchases.dto';
import {
  ShowDailyQuotaBarConfigDto,
  UpdateShowDailyQuotaBarDto,
} from './dto/show-daily-quota-bar.dto';
import { StrictInventoryConfigDto, UpdateStrictInventoryDto } from './dto/strict-inventory.dto';
import { TicketPrintConfigDto, UpdateTicketPrintDto } from './dto/ticket-print.dto';
import { TurnosConfigDto, UpdateTurnosDto } from './dto/turnos.dto';
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
    private readonly getIncludeOrdersInReportsAction: GetIncludeOrdersInReportsAction,
    private readonly upsertIncludeOrdersInReportsAction: UpsertIncludeOrdersInReportsAction,
    private readonly getShowAllBaseProductsInPurchasesAction: GetShowAllBaseProductsInPurchasesAction,
    private readonly upsertShowAllBaseProductsInPurchasesAction: UpsertShowAllBaseProductsInPurchasesAction,
    private readonly getShowDailyQuotaBarAction: GetShowDailyQuotaBarAction,
    private readonly upsertShowDailyQuotaBarAction: UpsertShowDailyQuotaBarAction,
    private readonly getEnableCreditPaymentAction: GetEnableCreditPaymentAction,
    private readonly upsertEnableCreditPaymentAction: UpsertEnableCreditPaymentAction,
    private readonly getEnableThirdPartyLoanAction: GetEnableThirdPartyLoanAction,
    private readonly upsertEnableThirdPartyLoanAction: UpsertEnableThirdPartyLoanAction,
    private readonly getTurnosAction: GetTurnosAction,
    private readonly upsertTurnosAction: UpsertTurnosAction,
    private readonly resetTurnosCounterAction: ResetTurnosCounterAction,
    private readonly getTicketPrintAction: GetTicketPrintAction,
    private readonly upsertTicketPrintAction: UpsertTicketPrintAction,
  ) {}

  // ----------------------------------------------------------------------
  // Endpoints específicos — paridad PlacePos. Declarados ANTES del
  // `@Get(':key')` genérico: el router los matchea por path exacto y
  // descarta el wildcard. Si se mueven, romperán con NOT_FOUND.
  // ----------------------------------------------------------------------

  @Get('pos-margins')
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
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
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
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
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
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

  @Get('include-orders-in-reports')
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Flag «incluir pedidos en informes»',
    description:
      'Devuelve `{ enabled }` desde la key `include_orders_in_reports`. Cuando está activo, los pedidos (ORDER) se suman a los ingresos del informe de ventas y a la facturación de Finanzas.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: IncludeOrdersInReportsConfigDto })
  async getIncludeOrdersInReports(
    @CurrentCompany() companyId: number,
  ): Promise<IncludeOrdersInReportsConfigDto> {
    return this.getIncludeOrdersInReportsAction.execute(companyId);
  }

  @Put('include-orders-in-reports')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'superadmin', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Set flag «incluir pedidos en informes»',
    description:
      'Solo `owner` o `superadmin` pueden modificar este flag — afecta cómo se contabilizan los ingresos en todos los informes.',
  })
  @ApiBody({ type: UpdateIncludeOrdersInReportsDto })
  @ApiResponse({ status: HttpStatus.OK, type: IncludeOrdersInReportsConfigDto })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Solo un administrador puede modificar esta configuración',
  })
  async upsertIncludeOrdersInReports(
    @Body() dto: UpdateIncludeOrdersInReportsDto,
    @CurrentCompany() companyId: number,
  ): Promise<IncludeOrdersInReportsConfigDto> {
    return this.upsertIncludeOrdersInReportsAction.execute(dto, companyId);
  }

  @Get('show-all-base-products-in-purchases')
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Flag «mostrar todos los productos base en compras»',
    description:
      'Devuelve `{ enabled }` desde la key `show_all_base_products_in_purchases`. Cuando está activo, todos los productos base aparecen en el buscador de compras sin necesidad de marcarlos "Disponible para compra".',
  })
  @ApiResponse({ status: HttpStatus.OK, type: ShowAllBaseProductsInPurchasesConfigDto })
  async getShowAllBaseProductsInPurchases(
    @CurrentCompany() companyId: number,
  ): Promise<ShowAllBaseProductsInPurchasesConfigDto> {
    return this.getShowAllBaseProductsInPurchasesAction.execute(companyId);
  }

  @Put('show-all-base-products-in-purchases')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'superadmin', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Set flag «mostrar todos los productos base en compras»',
    description:
      'Lo gestionan administradores Y dueños (a diferencia de `include-orders-in-reports`, que es owner-only): no mueve dinero ni datos, solo decide qué lista el buscador de compras.',
  })
  @ApiBody({ type: UpdateShowAllBaseProductsInPurchasesDto })
  @ApiResponse({ status: HttpStatus.OK, type: ShowAllBaseProductsInPurchasesConfigDto })
  async upsertShowAllBaseProductsInPurchases(
    @Body() dto: UpdateShowAllBaseProductsInPurchasesDto,
    @CurrentCompany() companyId: number,
  ): Promise<ShowAllBaseProductsInPurchasesConfigDto> {
    return this.upsertShowAllBaseProductsInPurchasesAction.execute(dto, companyId);
  }

  @Get('show-daily-quota-bar')
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Flag «mostrar barra de cuota diaria en el POS»',
    description:
      'Devuelve `{ enabled }` desde la key `show_daily_quota_bar`. Cuando está activo, el POS muestra la barra de progreso de la cuota diaria (semáforo) a los admins.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: ShowDailyQuotaBarConfigDto })
  async getShowDailyQuotaBar(
    @CurrentCompany() companyId: number,
  ): Promise<ShowDailyQuotaBarConfigDto> {
    return this.getShowDailyQuotaBarAction.execute(companyId);
  }

  @Put('show-daily-quota-bar')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'superadmin', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Set flag «mostrar barra de cuota diaria en el POS»',
    description: 'Solo un administrador (canAccessSettings) puede activar o desactivar la barra.',
  })
  @ApiBody({ type: UpdateShowDailyQuotaBarDto })
  @ApiResponse({ status: HttpStatus.OK, type: ShowDailyQuotaBarConfigDto })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Solo un administrador puede modificar esta configuración',
  })
  async upsertShowDailyQuotaBar(
    @Body() dto: UpdateShowDailyQuotaBarDto,
    @CurrentCompany() companyId: number,
  ): Promise<ShowDailyQuotaBarConfigDto> {
    return this.upsertShowDailyQuotaBarAction.execute(dto, companyId);
  }

  // ----------------------------------------------------------------------
  // Ventana de Cobro de Pedido: visibilidad de medios de pago del POS.
  // ----------------------------------------------------------------------

  // NOTA (A1): estos dos GET NO exigen `canAccessSettings`. El PaymentModal del
  // POS los lee con CUALQUIER rol (cajero/vendedor incluidos) para decidir si
  // pinta la tarjeta de Crédito / Préstamo. Si exigieran el permiso, el cajero
  // recibiría 403 y el front caería al fallback (mostrando Crédito siempre). El
  // guard SÍ se mantiene en los PUT: solo quien administra ajustes cambia el flag.
  @Get('credit-payment')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Flag «habilitar pago a Crédito»',
    description:
      'Devuelve `{ enabled }` desde la key `enable_credit_payment`. Default TRUE: si la fila no existe, el crédito viene visible en el POS. Legible por cualquier rol autenticado (lo consume el PaymentModal).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: CreditPaymentConfigDto })
  async getEnableCreditPayment(
    @CurrentCompany() companyId: number,
  ): Promise<CreditPaymentConfigDto> {
    return this.getEnableCreditPaymentAction.execute(companyId);
  }

  @Put('credit-payment')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'superadmin', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Set flag «habilitar pago a Crédito»',
    description:
      'Un administrador (canAccessSettings) muestra u oculta la tarjeta "Crédito" en el POS para TODOS los usuarios del negocio.',
  })
  @ApiBody({ type: UpdateCreditPaymentDto })
  @ApiResponse({ status: HttpStatus.OK, type: CreditPaymentConfigDto })
  async upsertEnableCreditPayment(
    @Body() dto: UpdateCreditPaymentDto,
    @CurrentCompany() companyId: number,
  ): Promise<CreditPaymentConfigDto> {
    return this.upsertEnableCreditPaymentAction.execute(dto, companyId);
  }

  // NOTA (A1): sin `canAccessSettings` (igual que credit-payment) — el
  // PaymentModal lo lee con cualquier rol para decidir la visibilidad del medio.
  // El gate real de negocio (owner-only + fail-closed) vive en el POST del
  // préstamo, no en este GET de lectura.
  @Get('third-party-loan')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Flag «habilitar Préstamo a Tercero»',
    description:
      'Devuelve `{ enabled }` desde la key `enable_third_party_loan`. Default FALSE. Habilita el medio "Préstamo a Tercero" (ORDER→LOAN). Legible por cualquier rol autenticado; el backend revalida el flag (fail-closed) al registrar el préstamo.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: ThirdPartyLoanConfigDto })
  async getEnableThirdPartyLoan(
    @CurrentCompany() companyId: number,
  ): Promise<ThirdPartyLoanConfigDto> {
    return this.getEnableThirdPartyLoanAction.execute(companyId);
  }

  @Put('third-party-loan')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'superadmin', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Set flag «habilitar Préstamo a Tercero»',
    description:
      'Un administrador (canAccessSettings) habilita o deshabilita el medio "Préstamo a Tercero". Solo el owner puede EJECUTAR préstamos; este flag solo controla la visibilidad del medio.',
  })
  @ApiBody({ type: UpdateThirdPartyLoanDto })
  @ApiResponse({ status: HttpStatus.OK, type: ThirdPartyLoanConfigDto })
  async upsertEnableThirdPartyLoan(
    @Body() dto: UpdateThirdPartyLoanDto,
    @CurrentCompany() companyId: number,
  ): Promise<ThirdPartyLoanConfigDto> {
    return this.upsertEnableThirdPartyLoanAction.execute(dto, companyId);
  }

  // ----------------------------------------------------------------------
  // Impresión del ticket: espacios para diligenciar a mano (observaciones y
  // firma) en el ticket térmico.
  // ----------------------------------------------------------------------

  // NOTA (A1): sin `canAccessSettings` — quien imprime el ticket es cualquier
  // rol (cajero/vendedor incluidos) y el main process lo lee con su token. Si
  // exigiera el permiso, el cajero recibiría 403 y el ticket saldría sin los
  // espacios. El guard SÍ se mantiene en el PUT.
  @Get('ticket-print')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Configuración de impresión del ticket (observaciones / firma)',
    description:
      'Devuelve `{ observations_enabled, observations_ticket_types, signature_enabled, signature_ticket_types }`. Default: apagados y en todos los tipos de ticket. Legible por cualquier rol autenticado (lo consume la impresión del ticket).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: TicketPrintConfigDto })
  async getTicketPrint(@CurrentCompany() companyId: number): Promise<TicketPrintConfigDto> {
    return this.getTicketPrintAction.execute(companyId);
  }

  @Put('ticket-print')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'superadmin', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Set configuración de impresión del ticket',
    description:
      'Actualización PARCIAL: cada campo enviado se persiste; los ausentes conservan su valor. Al menos uno es obligatorio.',
  })
  @ApiBody({ type: UpdateTicketPrintDto })
  @ApiResponse({ status: HttpStatus.OK, type: TicketPrintConfigDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload sin campos' })
  async upsertTicketPrint(
    @Body() dto: UpdateTicketPrintDto,
    @CurrentCompany() companyId: number,
  ): Promise<TicketPrintConfigDto> {
    return this.upsertTicketPrintAction.execute(dto, companyId);
  }

  // ----------------------------------------------------------------------
  // TURNOS de pedido (solo modo restaurante). Contador cíclico + 2º ticket.
  // ----------------------------------------------------------------------

  @Get('turnos')
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Configuración de turnos de pedido',
    description:
      'Devuelve `{ enabled, max, counter }`. `counter` es el último turno asignado (solo lectura). Solo relevante en modo restaurante.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: TurnosConfigDto })
  async getTurnos(@CurrentCompany() companyId: number): Promise<TurnosConfigDto> {
    return this.getTurnosAction.execute(companyId);
  }

  @Put('turnos')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'superadmin', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Set configuración de turnos de pedido',
    description:
      'Upsert de `turnos_enabled` + `turnos_max` (1..99). NO toca el contador. Al activar, cada pedido nuevo recibe un turno y se imprime un 2º ticket con el número grande.',
  })
  @ApiBody({ type: UpdateTurnosDto })
  @ApiResponse({ status: HttpStatus.OK, type: TurnosConfigDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Payload inválido (max fuera de 1..99)',
  })
  async upsertTurnos(
    @Body() dto: UpdateTurnosDto,
    @CurrentCompany() companyId: number,
  ): Promise<TurnosConfigDto> {
    return this.upsertTurnosAction.execute(dto, companyId);
  }

  @Post('turnos/reset')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'superadmin', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({
    summary: 'Reiniciar el contador de turnos a 0',
    description: 'El próximo turno asignado será 1. No cambia `enabled` ni `max`.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: TurnosConfigDto })
  async resetTurnosCounter(@CurrentCompany() companyId: number): Promise<TurnosConfigDto> {
    return this.resetTurnosCounterAction.execute(companyId);
  }

  // ----------------------------------------------------------------------
  // Endpoints genéricos clave-valor (DESPUÉS de los específicos).
  // ----------------------------------------------------------------------

  @Get()
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
  @ApiOperation({ summary: 'Listar todos los settings de la company autenticada' })
  @ApiResponse({ status: HttpStatus.OK, type: [AppSettingResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  async findAll(@CurrentCompany() companyId: number): Promise<AppSettingResponseDto[]> {
    const settings = await this.appSettingsService.findAll(companyId);
    return settings.map(toAppSettingResponseDto);
  }

  @Get(':key')
  @Roles('owner', 'manager', 'employee')
  @RequirePermission('canAccessSettings')
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
