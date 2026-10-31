import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';

import { MAX_AUDIO_BASE64_LENGTH } from '../../seller-agent.service';
import { WhatsappWebRelayService, type WhatsappWebReplyResult } from './whatsapp-web-relay.service';

/** Payload de `POST /sales-bot/whatsapp-web/reply`. */
export class WhatsappWebReplyDto {
  @ApiProperty({ description: 'JID del chat del cliente (WhatsApp).' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  chat_id!: string;

  @ApiPropertyOptional({ description: 'Texto que escribió el cliente (vacío si es nota de voz).' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  text?: string;

  @ApiPropertyOptional({ description: 'Nota de voz del cliente en base64 (sin prefijo data:).' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_AUDIO_BASE64_LENGTH)
  audio_base64?: string;

  @ApiPropertyOptional({ description: 'Tipo MIME de la nota de voz (ej. audio/ogg; codecs=opus).' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  audio_mime_type?: string;

  @ApiPropertyOptional({ description: 'Nombre visible del cliente (pushName).' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  sender_name?: string;

  @ApiPropertyOptional({
    description: 'Número del WhatsApp del negocio conectado (identifica el canal en el pedido).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  business_phone?: string;

  @ApiPropertyOptional({
    description:
      'Número del cliente (dígitos con indicativo), también en chats con identidad oculta (@lid).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customer_phone?: string;

  @ApiProperty({ description: 'Id del mensaje en WhatsApp (dedupe).' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  message_id!: string;
}

/** Payload de `POST /sales-bot/whatsapp-web/takeover`. */
export class WhatsappWebTakeoverDto {
  @ApiProperty({ description: 'JID del chat donde respondió un humano.' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  chat_id!: string;
}

/**
 * `/sales-bot/whatsapp-web` — relay del WhatsApp conectado por QR en la app de
 * escritorio. Autenticado con el JWT normal: lo llama el proceso main del PC
 * donde está la sesión, con el usuario que esté logueado (puede ser un cajero),
 * por eso no exige nivel admin. El negocio sale del token.
 */
@ApiTags('sales-bot')
@ApiBearerAuth('bearer')
@Controller('sales-bot/whatsapp-web')
export class WhatsappWebRelayController {
  constructor(private readonly relay: WhatsappWebRelayService) {}

  @Post('reply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mensaje entrante de WhatsApp (QR) → respuesta del vendedor Place.' })
  reply(
    @Body() dto: WhatsappWebReplyDto,
    @CurrentCompany() companyId: number,
  ): Promise<WhatsappWebReplyResult> {
    return this.relay.reply(companyId, dto);
  }

  @Post('takeover')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Un humano respondió en el chat: el agente se pausa ahí hasta el día siguiente.',
  })
  takeover(
    @Body() dto: WhatsappWebTakeoverDto,
    @CurrentCompany() companyId: number,
  ): Promise<{ paused_until: string }> {
    return this.relay.takeover(companyId, dto.chat_id);
  }
}
