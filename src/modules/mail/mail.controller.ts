import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '@/common/decorators/public.decorator';
import { AdminSignatureGuard } from '@/common/guards/admin-signature.guard';

import { SendTestEmailAction } from './actions/send-test-email.action';
import {
  MailStatusResponseDto,
  MailTemplateDto,
  MailTestResponseDto,
} from './dto/mail-status-response.dto';
import { SendTestEmailDto } from './dto/send-test-email.dto';
import { MailService } from './mail.service';
import { EMAIL_TEMPLATES } from './templates/template-catalog';

/**
 * Endpoints `/admin/mail/*` para el panel kdevs-admin: estado del servidor de
 * envíos y prueba manual.
 *
 * Autenticación por FIRMA Ed25519 (`AdminSignatureGuard`, la misma que
 * `/admin/users/owners`), no JWT: `@Public()` salta los guards globales. El
 * panel firma desde SU servidor con `POSAPI_SIGNING_PRIVATE_KEY`.
 *
 * NOTA sobre el POST: `AdminSignatureGuard` reconstruye el mensaje canónico con
 * el hash del cuerpo VACÍO (ver su JSDoc), así que el panel firma
 * `POST\n/admin/mail/test\n<ts>\nsha256('')` — igual que ya hace con
 * `/migration-import` y `migrate-catalog`. La integridad del cuerpo se apoya en
 * HTTPS + la ventana anti-replay del timestamp. Es aceptable aquí porque lo
 * peor que consigue un atacante que reproduzca la firma dentro de la ventana es
 * mandarse a sí mismo un correo de prueba sin datos del negocio.
 */
@ApiTags('mail')
@Public()
@SkipThrottle()
@UseGuards(AdminSignatureGuard)
@Controller('admin/mail')
export class MailController {
  constructor(
    private readonly mailService: MailService,
    private readonly sendTestEmailAction: SendTestEmailAction,
  ) {}

  @Get('status')
  @ApiOperation({
    summary: 'Estado del servidor de envíos de correo.',
    description:
      'Verifica las credenciales del proveedor SIN enviar nada y añade la ' +
      'actividad real de envíos de este proceso (enviados, fallidos, último ' +
      'error). El `level` resume ambas cosas en un semáforo.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: MailStatusResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Firma ausente/inválida/expirada' })
  getStatus(): Promise<MailStatusResponseDto> {
    return this.mailService.getStatus();
  }

  @Get('templates')
  @ApiOperation({
    summary: 'Catálogo de plantillas de correo disponibles.',
    description:
      'La lista sale del código (`template-catalog.ts`), no de una tabla: el ' +
      'panel se entera de una plantilla nueva sin tocar el front.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [MailTemplateDto] })
  listTemplates(): MailTemplateDto[] {
    return [...EMAIL_TEMPLATES];
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Envía un correo de prueba a la dirección indicada.',
    description:
      'Con `template` manda esa plantilla con datos de muestra (para revisar ' +
      'el diseño); sin él, el correo de diagnóstico simple. Responde 200 con ' +
      '`ok: false` y el motivo si el proveedor rechaza el envío: el fallo ES ' +
      'el diagnóstico que se pidió, no un error del panel.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: MailTestResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Dirección inválida' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Firma ausente/inválida/expirada' })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'El servidor no tiene proveedor de correo configurado',
  })
  sendTest(@Body() dto: SendTestEmailDto): Promise<MailTestResponseDto> {
    return this.sendTestEmailAction.execute(dto.to, dto.template);
  }
}
