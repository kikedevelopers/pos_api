import { ApiProperty } from '@nestjs/swagger';

/** Actividad de envíos del proceso actual (se reinicia con cada despliegue). */
export class MailActivityDto {
  @ApiProperty({ example: 12 })
  sentCount!: number;

  @ApiProperty({ example: 0 })
  failedCount!: number;

  @ApiProperty({ example: '2026-08-12T14:03:11.512Z', nullable: true })
  lastSuccessAt!: string | null;

  @ApiProperty({ example: null, nullable: true })
  lastErrorAt!: string | null;

  @ApiProperty({ example: null, nullable: true })
  lastErrorMessage!: string | null;

  @ApiProperty({ example: 0 })
  consecutiveFailures!: number;
}

/** Respuesta de `GET /admin/mail/status`. Es lo que pinta el panel. */
export class MailStatusResponseDto {
  @ApiProperty({ example: 'resend', description: 'Proveedor activo.' })
  driver!: string;

  @ApiProperty({ example: true, description: 'Hay credenciales configuradas.' })
  configured!: boolean;

  @ApiProperty({ example: true, description: 'El proveedor respondió correctamente.' })
  healthy!: boolean;

  @ApiProperty({
    example: 'ok',
    enum: ['ok', 'warning', 'error', 'disabled'],
    description: 'Semáforo para el panel.',
  })
  level!: string;

  @ApiProperty({ example: 'Operativo: los correos están saliendo.' })
  summary!: string;

  @ApiProperty({ example: 'Credencial válida y API accesible.' })
  detail!: string;

  @ApiProperty({ example: 184, nullable: true })
  latencyMs!: number | null;

  @ApiProperty({ example: 'PlacePOS <no-reply@kikedevs.com>' })
  from!: string;

  @ApiProperty({ example: 'production' })
  environment!: string;

  @ApiProperty({ type: MailActivityDto })
  activity!: MailActivityDto;

  @ApiProperty({ example: '2026-08-12T14:05:00.000Z' })
  checkedAt!: string;
}

/** Una plantilla del catálogo (`GET /admin/mail/templates`). */
export class MailTemplateDto {
  @ApiProperty({ example: 'welcome' })
  id!: string;

  @ApiProperty({ example: 'Bienvenida' })
  name!: string;

  @ApiProperty({ example: 'Saluda al dueño y confirma el negocio registrado.' })
  description!: string;

  @ApiProperty({ example: 'Al registrarse un owner nuevo en la nube.' })
  trigger!: string;
}

/** Respuesta de `POST /admin/mail/test`. */
export class MailTestResponseDto {
  @ApiProperty({ example: true, description: 'El proveedor aceptó el envío.' })
  ok!: boolean;

  @ApiProperty({ example: 'k***e@esenciaygrano.com', description: 'Destinatario enmascarado.' })
  to!: string;

  @ApiProperty({ example: 'resend' })
  provider!: string;

  @ApiProperty({ example: '3f1b…', nullable: true })
  messageId!: string | null;

  @ApiProperty({ example: 412, nullable: true })
  durationMs!: number | null;

  @ApiProperty({
    example: 'welcome',
    nullable: true,
    description: 'Plantilla enviada, o null si fue el diagnóstico simple.',
  })
  template!: string | null;

  @ApiProperty({ example: 'Correo de prueba enviado. Revisa la bandeja de entrada.' })
  message!: string;
}
