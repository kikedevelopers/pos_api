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

/** Payload de `PUT /sales-bot/config` — configura el bot de Telegram del negocio. */
export class UpdateSalesBotConfigDto {
  @ApiProperty({
    example: 'Andrea',
    description: 'Nombre con el que el bot se presenta en el chat. Máx. 60 caracteres.',
  })
  @IsString()
  @MaxLength(60)
  bot_name!: string;

  @ApiProperty({
    enum: SALES_BOT_PERSONALITY_VALUES,
    example: 'amable_profesional',
    description: 'Personalidad de venta del bot (tono).',
  })
  @IsIn(SALES_BOT_PERSONALITY_VALUES as unknown as string[])
  personality!: SalesBotPersonality;

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
  @ApiProperty({ example: 'Andrea', description: 'Nombre con el que el bot se presenta. Máx. 60.' })
  @IsString()
  @MaxLength(60)
  bot_name!: string;

  @ApiProperty({ enum: SALES_BOT_PERSONALITY_VALUES, example: 'amable_profesional' })
  @IsIn(SALES_BOT_PERSONALITY_VALUES as unknown as string[])
  personality!: SalesBotPersonality;

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
