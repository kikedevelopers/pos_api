import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  IsString,
  MaxLength,
} from 'class-validator';

import {
  SALES_BOT_PERSONALITY_VALUES,
  type SalesBotPersonality,
} from '../entities/sales-bot-config.entity';
import {
  MAX_SALES_BOT_OFF_TOPIC_LIMIT,
  MAX_SALES_BOT_PICKUP_ADDRESS_LEN,
  SALES_BOT_DELIVERY_MODE_VALUES,
  type SalesBotDeliveryMode,
  MAX_SALES_BOT_PAYMENT_INSTRUCTIONS_LEN,
  MAX_SALES_BOT_STYLE_LEN,
  SALES_BOT_PAYMENT_METHOD_VALUES,
  SALES_BOT_STOCK_POLICY_VALUES,
  type SalesBotPaymentMethod,
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

  @ApiPropertyOptional({
    example: 'Saluda con "¡Hola, vecino!" y pregunta qué receta va a preparar.',
    description: 'Cómo quiere el dueño que salude. Máx. 500. Vacío = el tono del preset.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SALES_BOT_STYLE_LEN)
  greeting_style?: string;

  @ApiPropertyOptional({
    example: 'Recomienda primero los productos de la casa y explica cómo se usan.',
    description: 'Cómo quiere el dueño que asesore y aborde la venta. Máx. 500.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SALES_BOT_STYLE_LEN)
  selling_style?: string;

  @ApiPropertyOptional({
    example: 'Al cerrar, recuerda que el domicilio es gratis desde $ 50.000.',
    description: 'Cómo quiere el dueño que cierre la venta. Máx. 500.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SALES_BOT_STYLE_LEN)
  closing_style?: string;

  @ApiPropertyOptional({
    enum: SALES_BOT_PAYMENT_METHOD_VALUES,
    isArray: true,
    example: ['cash', 'bank_transfer'],
    description: 'Formas de pago que acepta el negocio (al menos una).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SALES_BOT_PAYMENT_METHOD_VALUES.length)
  @IsIn(SALES_BOT_PAYMENT_METHOD_VALUES as unknown as string[], { each: true })
  payment_methods?: SalesBotPaymentMethod[];

  @ApiPropertyOptional({
    example: 'Transferencias a Nequi 300 123 4567. Datáfono solo en domicilios.',
    description: 'Indicaciones de pago que el agente comparte. Máx. 300.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SALES_BOT_PAYMENT_INSTRUCTIONS_LEN)
  payment_instructions?: string;

  @ApiPropertyOptional({
    enum: SALES_BOT_DELIVERY_MODE_VALUES,
    isArray: true,
    example: ['pickup'],
    description:
      'Entregas que ofrece el negocio: pickup (recogen en el negocio) y/o delivery (domicilio). Al menos una.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SALES_BOT_DELIVERY_MODE_VALUES.length)
  @IsIn(SALES_BOT_DELIVERY_MODE_VALUES as unknown as string[], { each: true })
  delivery_modes?: SalesBotDeliveryMode[];

  @ApiPropertyOptional({
    example: 'Calle 10 # 5-20, local 3, Centro',
    description: 'Dónde se recoge. Vacío = la dirección del negocio. Máx. 250.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SALES_BOT_PICKUP_ADDRESS_LEN)
  pickup_address?: string;

  @ApiPropertyOptional({
    example: 3,
    minimum: 0,
    maximum: MAX_SALES_BOT_OFF_TOPIC_LIMIT,
    description:
      'Mensajes fuera de tema (molestar, preguntas sin sentido) antes de que el agente se despida y deje de responder hasta que sea algo del negocio. 0 = filtro apagado.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_SALES_BOT_OFF_TOPIC_LIMIT)
  off_topic_limit?: number;
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
