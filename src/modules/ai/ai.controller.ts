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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import type { AiAttachmentView } from './actions/ai-attachments.action';
import { AiService, type AiGreeting, type AiStatus } from './ai.service';
import { AiChatRequestDto } from './dto/ai-chat.dto';
import { MAX_ATTACHMENT_BYTES } from './internal/attachments';
import { SseWriter } from './internal/sse-writer';

/**
 * Endpoints `/ai` — PlacePOS IA.
 *
 * `POST /ai/chat` NO devuelve JSON: abre un stream SSE porque la respuesta se
 * escribe token a token. Por eso usa `@Res()` crudo (sin `passthrough`), lo que
 * lo deja fuera del `ResponseWrapperInterceptor` a propósito.
 *
 * `POST /ai/attachments` sube una foto o un PDF (una vez, al Files API de
 * Google) y devuelve su id; el chat lo referencia en `turns[].attachment_ids`.
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
  status(@CurrentUser() user: AuthUser, @CurrentCompany() companyId: number): Promise<AiStatus> {
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

  @Post('attachments')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      // Un byte de holgura: el action da el mensaje exacto del límite.
      limits: { fileSize: MAX_ATTACHMENT_BYTES + 1, files: 1 },
    }),
  )
  @ApiOperation({
    summary: 'Adjuntar una foto o un PDF para que Place lo analice.',
    description:
      'Multipart con el campo `file` (JPG, PNG, WebP, HEIC o PDF; validado por los bytes reales). ' +
      'No gasta consultas. El archivo vence a las 47 horas.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiResponse({ status: HttpStatus.CREATED })
  @ApiResponse({ status: HttpStatus.UNPROCESSABLE_ENTITY, description: 'No es foto ni PDF' })
  @ApiResponse({ status: HttpStatus.PAYLOAD_TOO_LARGE, description: 'Supera el límite' })
  uploadAttachment(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
    @CurrentCompany() companyId: number,
  ): Promise<AiAttachmentView> {
    return this.aiService.uploadAttachment(user, companyId, file);
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
    // Gate por cuenta ANTES de abrir el stream: si Place no está habilitado para
    // esta company, respondemos 403 (AI_NOT_ENABLED) como error HTTP normal —
    // el cliente lo muestra sin siquiera iniciar la respuesta.
    // …y reserva 1 crédito del día (429 AI_CREDITS_EXHAUSTED si no quedan).
    const reservation = await this.aiService.reserveChatCredit(companyId);

    const writer = new SseWriter(response);
    // Primero el saldo: el cliente bloquea la caja de texto si este era el último.
    writer.send('credits', reservation.status);
    // Si la respuesta falla antes de decir algo, el crédito se devuelve.
    let answered = false;
    let failed = false;
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
          if (event.type === 'delta' || event.type === 'card') answered = true;
          if (event.type === 'error') failed = true;
          const { type, ...data } = event;
          writer.send(type, data);
        },
      });
    } catch (error) {
      failed = true;
      this.logger.error({ err: error, companyId, userId: user.user_id }, 'Fallo en /ai/chat');
      writer.send('error', {
        message: 'Ocurrió un error inesperado al hablar con la IA. Intenta de nuevo.',
      });
    } finally {
      writer.close();
      if (failed && !answered) {
        await this.aiService.refundChatCredit(reservation);
      }
    }
  }
}
