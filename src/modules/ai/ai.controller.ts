import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { AiService, type AiGreeting, type AiStatus } from './ai.service';
import { AiChatRequestDto } from './dto/ai-chat.dto';
import { SseWriter } from './internal/sse-writer';

/**
 * Endpoints `/ai` — PlacePOS IA.
 *
 * `POST /ai/chat` NO devuelve JSON: abre un stream SSE porque la respuesta se
 * escribe token a token. Por eso usa `@Res()` crudo (sin `passthrough`), lo que
 * lo deja fuera del `ResponseWrapperInterceptor` a propósito.
 *
 * Eventos del stream:
 *   - `delta` → `{ text }` — pedazo de la respuesta.
 *   - `tool`  → `{ name, label, status }` — el asistente está consultando la BD.
 *   - `done`  → `{ notice? }` — terminó; `notice` explica un corte anómalo.
 *   - `error` → `{ message }` — mensaje listo para mostrarle al usuario.
 *
 * Este módulo NO existe en el servidor Express de placepos: la IA es cloud-only
 * (la llave vive en el servidor y el asistente consulta la base multi-tenant).
 */
@ApiTags('ai')
@ApiBearerAuth('bearer')
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(private readonly aiService: AiService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Disponibilidad de Place, modelo en uso y herramientas del usuario.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  status(
    @CurrentUser() user: AuthUser,
    @CurrentCompany() companyId: number,
  ): Promise<AiStatus> {
    return this.aiService.status(user, companyId);
  }

  @Get('greeting')
  @ApiOperation({ summary: 'Saludo de bienvenida del chat, escrito por Place.' })
  @ApiResponse({ status: HttpStatus.OK })
  greeting(
    @CurrentUser() user: AuthUser,
    @CurrentCompany() companyId: number,
  ): Promise<AiGreeting> {
    return this.aiService.greeting(user, companyId);
  }

  @Post('chat')
  // Un stream no "crea" nada: 200, no el 201 por defecto de Nest para POST.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Conversación con PlacePOS IA (stream SSE). El asistente consulta la base del negocio.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'text/event-stream' })
  async chat(
    @Body() dto: AiChatRequestDto,
    @CurrentUser() user: AuthUser,
    @CurrentCompany() companyId: number,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const writer = new SseWriter(response);
    const abort = new AbortController();

    // El usuario cerró la pestaña o pulsó "detener": cortamos la generación
    // para no seguir gastando tokens contra Google.
    request.on('close', () => abort.abort());

    try {
      await this.aiService.chat({
        user,
        companyId,
        turns: dto.turns,
        model: dto.model,
        signal: abort.signal,
        emit: (event) => {
          const { type, ...data } = event;
          writer.send(type, data);
        },
      });
    } catch (error) {
      this.logger.error({ err: error, companyId, userId: user.user_id }, 'Fallo en /ai/chat');
      writer.send('error', {
        message: 'Ocurrió un error inesperado al hablar con la IA. Intenta de nuevo.',
      });
    } finally {
      writer.close();
    }
  }
}
