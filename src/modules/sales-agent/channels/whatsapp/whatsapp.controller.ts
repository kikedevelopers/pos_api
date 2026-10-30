import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';

import type { WhatsappConfig } from '@/config/whatsapp.config';
import { Public } from '@/common/decorators/public.decorator';
import { RawResponse } from '@/common/decorators/raw-response.decorator';
import { SkipActiveCompanyCheck } from '@/common/decorators/skip-active-company-check.decorator';
import { SkipSubscriptionCheck } from '@/modules/subscriptions/skip-subscription-check.decorator';

import { WhatsappHandlerService } from './whatsapp-handler.service';
import { verifyWhatsappSignature } from './whatsapp-signature';
import { parseWhatsappWebhook } from './whatsapp-webhook.parser';

/**
 * Webhook de WhatsApp (Cloud API de Meta). ÚNICO para toda la plataforma: Meta
 * lo llama y aquí se rutea cada mensaje al negocio dueño del número.
 *
 * Público (lo llama Meta), autenticado por:
 *   - GET: el reto de verificación (`hub.verify_token` == nuestro verify token).
 *   - POST: la FIRMA del cuerpo (`X-Hub-Signature-256`, HMAC con el app secret).
 *
 * Responde 200 de inmediato y procesa en segundo plano: Meta trata cualquier
 * otro código o demora como fallo y reintenta (lo que duplicaría respuestas).
 */
@ApiExcludeController()
@Controller('sales-bot/whatsapp/webhook')
@Public()
@RawResponse()
@SkipThrottle()
@SkipSubscriptionCheck()
@SkipActiveCompanyCheck()
export class WhatsappWebhookController {
  constructor(
    private readonly handler: WhatsappHandlerService,
    private readonly configService: ConfigService,
  ) {}

  private get config(): WhatsappConfig {
    return this.configService.getOrThrow<WhatsappConfig>('whatsapp');
  }

  /** Verificación del webhook: Meta espera que devolvamos el `hub.challenge`. */
  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): string {
    const expected = this.config.verifyToken;
    if (mode === 'subscribe' && expected && verifyToken === expected) {
      return challenge ?? '';
    }
    throw new ForbiddenException('Verificación de webhook de WhatsApp fallida.');
  }

  /** Eventos entrantes (mensajes). Verifica firma, responde 200 y procesa aparte. */
  @Post()
  @HttpCode(HttpStatus.OK)
  receive(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ): { received: true } {
    const ok = verifyWhatsappSignature(req.rawBody, signature, this.config.appSecret);
    if (!ok) {
      // Firma inválida = no es Meta (o app secret mal configurado). 400 sin procesar.
      throw new BadRequestException('Firma del webhook de WhatsApp inválida.');
    }

    const messages = parseWhatsappWebhook(body);
    if (messages.length > 0) {
      // Sin await: respondemos 200 ya y procesamos en segundo plano.
      void this.handler.process(messages);
    }
    return { received: true };
  }
}
