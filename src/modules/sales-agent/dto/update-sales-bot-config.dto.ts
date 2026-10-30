import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import {
  SALES_BOT_PERSONALITY_VALUES,
  type SalesBotPersonality,
} from '../entities/sales-bot-config.entity';
import {
  SALES_BOT_STOCK_POLICY_VALUES,
  type SalesBotStockPolicy,
} from '../entities/sales-bot-settings.entity';

/**
 * Payload de `PUT /sales-bot/settings` — ajustes del agente (iguales en todos
 * los canales). Los campos omitidos conservan su valor.
 */
export class UpdateSalesBotSettingsDto {
  @ApiPropertyOptional({
    example: 'Andrea',
    description: 'Nombre con el que el asistente se presenta. Máx. 60. Vacío = nombre por defecto.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  bot_name?: string;

  @ApiPropertyOptional({
    enum: SALES_BOT_PERSONALITY_VALUES,
    example: 'amable_profesional',
    description: 'Personalidad de venta (tono).',
  })
  @IsOptional()
  @IsIn(SALES_BOT_PERSONALITY_VALUES as unknown as string[])
  personality?: SalesBotPersonality;

  @ApiPropertyOptional({
    enum: SALES_BOT_STOCK_POLICY_VALUES,
    example: 'inform',
    description:
      'inform = avisa cuando no hay existencias; offer_always = ofrece y vende sin mencionar el stock.',
  })
  @IsOptional()
  @IsIn(SALES_BOT_STOCK_POLICY_VALUES as unknown as string[])
  stock_policy?: SalesBotStockPolicy;
}

/** Payload de `PUT /sales-bot/config` — configura el bot de Telegram del negocio. */
export class UpdateSalesBotConfigDto {
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Obsoleto: la persona vive en `PUT /sales-bot/settings`. Se ignora.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  bot_name?: string;

  @ApiPropertyOptional({
    deprecated: true,
    enum: SALES_BOT_PERSONALITY_VALUES,
    description: 'Obsoleto: la persona vive en `PUT /sales-bot/settings`. Se ignora.',
  })
  @IsOptional()
  @IsIn(SALES_BOT_PERSONALITY_VALUES as unknown as string[])
  personality?: SalesBotPersonality;

  @ApiProperty({ example: true, description: 'true = el bot atiende; false = apagado.' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    description:
      'Token de @BotFather. Omítelo o déjalo vacío para conservar el guardado. Un valor nuevo se valida con Telegram antes de guardarse.',
  })
  @IsOptional()
  @IsString()
  token?: string;

  @ApiPropertyOptional({
    description: 'Chat de Telegram del dueño al que el bot avisa cada pedido cerrado.',
  })
  @IsOptional()
  @IsString()
  owner_chat_id?: string;
}

/** Payload de `POST /sales-bot/validate-token` — verifica un token sin guardarlo. */
export class ValidateSalesBotTokenDto {
  @ApiProperty({ description: 'Token de @BotFather a verificar.' })
  @IsString()
  token!: string;
}

/** Payload de `PUT /sales-bot/whatsapp/config` — configura WhatsApp (modo manual). */
export class UpdateWhatsappConfigDto {
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Obsoleto: la persona vive en `PUT /sales-bot/settings`. Se ignora.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  bot_name?: string;

  @ApiPropertyOptional({
    deprecated: true,
    enum: SALES_BOT_PERSONALITY_VALUES,
    description: 'Obsoleto: la persona vive en `PUT /sales-bot/settings`. Se ignora.',
  })
  @IsOptional()
  @IsIn(SALES_BOT_PERSONALITY_VALUES as unknown as string[])
  personality?: SalesBotPersonality;

  @ApiProperty({ example: true, description: 'true = el bot atiende por WhatsApp.' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ description: 'Phone number ID del número (lo da Meta).' })
  @IsOptional()
  @IsString()
  phone_number_id?: string;

  @ApiPropertyOptional({
    description: 'Token de acceso propio del negocio. Omítelo para usar el compartido o conservar.',
  })
  @IsOptional()
  @IsString()
  token?: string;

  @ApiPropertyOptional({ description: 'WhatsApp Business Account ID (informativo).' })
  @IsOptional()
  @IsString()
  waba_id?: string;

  @ApiPropertyOptional({
    description: 'Número de WhatsApp del dueño al que avisar cada pedido cerrado.',
  })
  @IsOptional()
  @IsString()
  owner_chat_id?: string;
}
