import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { EMAIL_TEMPLATES, type EmailTemplateId } from '../templates/template-catalog';

const TEMPLATE_IDS = EMAIL_TEMPLATES.map((template) => template.id);

/**
 * Payload de `POST /admin/mail/test`. Un solo destinatario a propósito: es una
 * prueba de diagnóstico, no una herramienta de envío masivo.
 */
export class SendTestEmailDto {
  @ApiProperty({
    example: 'kike@esenciaygrano.com',
    description: 'Dirección a la que se envía el correo de prueba.',
  })
  @IsString()
  @MaxLength(254, { message: 'to no puede exceder 254 caracteres' })
  @IsEmail({}, { message: 'to debe ser una dirección de correo válida' })
  to!: string;

  @ApiPropertyOptional({
    enum: TEMPLATE_IDS,
    description:
      'Plantilla a enviar, con datos de muestra. Si se omite, se manda el ' +
      'correo de diagnóstico simple (verifica la conexión, no el diseño).',
  })
  @IsOptional()
  @IsIn(TEMPLATE_IDS, { message: 'template no está en el catálogo de plantillas' })
  template?: EmailTemplateId;
}
