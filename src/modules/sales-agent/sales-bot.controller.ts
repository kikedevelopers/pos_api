import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { AdminLevelGuard } from '@/common/guards/admin-level.guard';

import { TelegramBotManager } from './channels/telegram/telegram-bot.manager';
import {
  UpdateSalesBotConfigDto,
  UpdateSalesBotSettingsDto,
  UpdateWhatsappConfigDto,
  ValidateSalesBotTokenDto,
} from './dto/update-sales-bot-config.dto';
import { SalesBotSettingsService, type SalesBotSettings } from './sales-bot-settings.service';
import {
  SalesBotConfigService,
  type SalesBotPublicConfig,
  type SalesBotWhatsappPublicConfig,
  type TokenValidationResult,
} from './sales-bot-config.service';

/**
 * `/sales-bot` — configuración del bot VENDEDOR (Place) por el dueño, desde el
 * menú "Asistente de ventas". Feature CLOUD.
 *
 * Gating: NIVEL ADMIN (owner/superadmin o empleado con rol Administrador) vía
 * `AdminLevelGuard`. El token de Telegram entra por aquí y NUNCA se devuelve.
 */
@ApiTags('sales-bot')
@ApiBearerAuth('bearer')
@Controller('sales-bot')
@UseGuards(AdminLevelGuard)
export class SalesBotController {
  constructor(
    private readonly botConfig: SalesBotConfigService,
    private readonly telegramManager: TelegramBotManager,
    private readonly botSettings: SalesBotSettingsService,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Ajustes de comportamiento del agente (todos los canales).' })
  @ApiResponse({ status: HttpStatus.OK })
  getSettings(@CurrentCompany() companyId: number): Promise<SalesBotSettings> {
    return this.botSettings.get(companyId);
  }

  @Put('settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Guarda los ajustes de comportamiento del agente.' })
  @ApiResponse({ status: HttpStatus.OK })
  updateSettings(
    @Body() dto: UpdateSalesBotSettingsDto,
    @CurrentCompany() companyId: number,
  ): Promise<SalesBotSettings> {
    return this.botSettings.update(companyId, {
      bot_name: dto.bot_name,
      personality: dto.personality,
      stock_policy: dto.stock_policy,
    });
  }

  @Get('config')
  @ApiOperation({ summary: 'Config del bot de Telegram del negocio (sin el token).' })
  @ApiResponse({ status: HttpStatus.OK })
  getConfig(@CurrentCompany() companyId: number): Promise<SalesBotPublicConfig> {
    return this.botConfig.getPublicConfig(companyId);
  }

  @Put('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Guarda la config del bot de Telegram (token, avisos, activar) y re-sincroniza.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  async updateConfig(
    @Body() dto: UpdateSalesBotConfigDto,
    @CurrentCompany() companyId: number,
  ): Promise<SalesBotPublicConfig> {
    const result = await this.botConfig.upsertTelegram(companyId, {
      enabled: dto.enabled,
      token: dto.token,
      owner_chat_id: dto.owner_chat_id,
    });
    // Aplica el cambio en caliente: arranca/detiene el bot del negocio.
    await this.telegramManager.refresh(companyId);
    return result;
  }

  @Post('validate-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verifica un token de Telegram (getMe) sin guardarlo.' })
  @ApiResponse({ status: HttpStatus.OK })
  validateToken(@Body() dto: ValidateSalesBotTokenDto): Promise<TokenValidationResult> {
    return this.botConfig.validateToken(dto.token);
  }

  @Get('whatsapp/config')
  @ApiOperation({ summary: 'Config del bot de WhatsApp del negocio (sin el token).' })
  @ApiResponse({ status: HttpStatus.OK })
  getWhatsappConfig(
    @CurrentCompany() companyId: number,
  ): Promise<SalesBotWhatsappPublicConfig> {
    return this.botConfig.getWhatsappPublicConfig(companyId);
  }

  @Put('whatsapp/config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Guarda la config de WhatsApp (modo manual).' })
  @ApiResponse({ status: HttpStatus.OK })
  updateWhatsappConfig(
    @Body() dto: UpdateWhatsappConfigDto,
    @CurrentCompany() companyId: number,
  ): Promise<SalesBotWhatsappPublicConfig> {
    return this.botConfig.upsertWhatsapp(companyId, {
      enabled: dto.enabled,
      phone_number_id: dto.phone_number_id,
      token: dto.token,
      waba_id: dto.waba_id,
      owner_chat_id: dto.owner_chat_id,
    });
  }
}
